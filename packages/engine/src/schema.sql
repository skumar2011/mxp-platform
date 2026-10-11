-- =====================================================================
-- MXP (Money XP) schema. SQLite dialect; types map 1:1 to PostgreSQL
-- (see docs/03-data-model.md for the PostgreSQL mapping).
--
-- Conventions
--   * Money is stored as INTEGER minor units (paise). Never floats.
--   * Timestamps are ISO-8601 UTC text. Business dates are 'YYYY-MM-DD'.
--   * Facts are append-only (xp_ledger, goal_contribution, audit_log,
--     txn_status_history). Projections (goal_progress, xp_account) can be
--     rebuilt from facts and are checked by reconciliation.
--   * The transaction master is the financial source of truth. MXP never
--     writes gamification outcomes to it.
-- =====================================================================

-- ---------- Reference data ------------------------------------------
CREATE TABLE channel_ref (
  channel_code TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  realtime     INTEGER NOT NULL DEFAULT 1 CHECK (realtime IN (0,1)),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE product_ref (
  product_code   TEXT PRIMARY KEY,
  product_family TEXT NOT NULL CHECK (product_family IN
    ('SAVINGS','CURRENT','CREDIT_CARD','DEBIT_CARD','UPI','LOAN','DEPOSIT','WALLET','OTHER')),
  name           TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE txn_type_ref (
  txn_type_code TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  is_reversal   INTEGER NOT NULL DEFAULT 0 CHECK (is_reversal IN (0,1))
);

CREATE TABLE txn_category_ref (
  category_code TEXT PRIMARY KEY,
  name          TEXT NOT NULL
);

CREATE TABLE segment (
  segment_code TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

-- ---------- Customer and account references -------------------------
-- Data minimisation: only tokens and a masked display name are held.
CREATE TABLE customer (
  customer_id    TEXT PRIMARY KEY,
  customer_ref   TEXT NOT NULL UNIQUE,          -- token from the CIF, never a raw identifier
  masked_name    TEXT,
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','CLOSED','BLOCKED')),
  customer_type  TEXT NOT NULL DEFAULT 'RETAIL' CHECK (customer_type IN ('RETAIL','SME','CORPORATE')),
  kyc_status     TEXT NOT NULL DEFAULT 'FULL' CHECK (kyc_status IN ('FULL','MINIMAL','PENDING')),
  nudge_consent  INTEGER NOT NULL DEFAULT 1 CHECK (nudge_consent IN (0,1)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE account (
  account_id   TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customer(customer_id),
  account_ref  TEXT NOT NULL UNIQUE,            -- tokenised account number
  product_code TEXT NOT NULL REFERENCES product_ref(product_code),
  account_type TEXT NOT NULL CHECK (account_type IN ('SAVINGS','CURRENT','CREDIT_CARD','DEBIT_CARD','UPI','LOAN','DEPOSIT','WALLET','OTHER')),
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DORMANT','FROZEN','CLOSED')),
  currency     TEXT NOT NULL DEFAULT 'INR',
  opened_on    TEXT NOT NULL,
  closed_on    TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX ix_account_customer ON account(customer_id);

CREATE TABLE instrument (
  instrument_id   TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customer(customer_id),
  account_id      TEXT REFERENCES account(account_id),
  instrument_ref  TEXT NOT NULL UNIQUE,         -- token, never a PAN
  instrument_type TEXT NOT NULL CHECK (instrument_type IN ('CREDIT_CARD','DEBIT_CARD','UPI_VPA','WALLET')),
  product_code    TEXT REFERENCES product_ref(product_code),
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','CLOSED'))
);
CREATE INDEX ix_instrument_customer ON instrument(customer_id);

CREATE TABLE customer_segment (
  customer_id  TEXT NOT NULL REFERENCES customer(customer_id),
  segment_code TEXT NOT NULL REFERENCES segment(segment_code),
  valid_from   TEXT NOT NULL,
  valid_to     TEXT,
  PRIMARY KEY (customer_id, segment_code)
);

-- ---------- Ingestion and processing history ------------------------
CREATE TABLE ingestion_batch (
  batch_id             TEXT PRIMARY KEY,
  source_system        TEXT NOT NULL,
  channel_code         TEXT REFERENCES channel_ref(channel_code),
  mode                 TEXT NOT NULL CHECK (mode IN ('STREAM','BATCH')),
  file_name            TEXT,
  control_count        INTEGER,                 -- declared by the source
  control_amount_minor INTEGER,
  received_count       INTEGER NOT NULL DEFAULT 0,
  accepted_count       INTEGER NOT NULL DEFAULT 0,
  rejected_count       INTEGER NOT NULL DEFAULT 0,
  duplicate_count      INTEGER NOT NULL DEFAULT 0,
  accepted_amount_minor INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','RECONCILED','MISMATCH')),
  created_at           TEXT NOT NULL,
  closed_at            TEXT
);

CREATE TABLE ingestion_event (
  event_id          TEXT PRIMARY KEY,
  batch_id          TEXT REFERENCES ingestion_batch(batch_id),
  source_system     TEXT NOT NULL,
  source_event_id   TEXT NOT NULL,
  event_type        TEXT NOT NULL CHECK (event_type IN ('TRANSACTION','BALANCE_SNAPSHOT')),
  payload_json      TEXT NOT NULL,              -- canonical payload kept verbatim for replay
  payload_hash      TEXT NOT NULL,
  received_at       TEXT NOT NULL,
  delivery_count    INTEGER NOT NULL DEFAULT 1, -- duplicate deliveries are counted, not re-stored
  last_delivered_at TEXT NOT NULL,
  processing_status TEXT NOT NULL CHECK (processing_status IN
    ('RECEIVED','NORMALIZED','PROCESSING','PROCESSED','REJECTED','SUSPENDED','FAILED','DEAD_LETTER')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT,
  error_code        TEXT,
  last_error        TEXT,
  txn_id            TEXT,                       -- resolved master row
  snapshot_id       TEXT,
  correlation_id    TEXT NOT NULL,
  processed_at      TEXT,
  UNIQUE (source_system, source_event_id)
);
CREATE INDEX ix_ing_queue  ON ingestion_event(processing_status, next_attempt_at);
CREATE INDEX ix_ing_txn    ON ingestion_event(txn_id);
CREATE INDEX ix_ing_batch  ON ingestion_event(batch_id);

CREATE TABLE ingestion_event_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL REFERENCES ingestion_event(event_id),
  stage      TEXT NOT NULL,                     -- INGEST, NORMALIZE, EVALUATE, RETRY, REPLAY, DEAD_LETTER
  outcome    TEXT NOT NULL,
  detail     TEXT,
  at         TEXT NOT NULL
);
CREATE INDEX ix_ing_hist_event ON ingestion_event_history(event_id);

-- ---------- Transaction master (financial source of truth) ----------
CREATE TABLE txn_master (
  txn_id             TEXT PRIMARY KEY,
  source_system      TEXT NOT NULL,
  source_txn_id      TEXT NOT NULL,
  customer_id        TEXT NOT NULL REFERENCES customer(customer_id),
  account_id         TEXT REFERENCES account(account_id),
  instrument_ref     TEXT,
  product_code       TEXT REFERENCES product_ref(product_code),
  txn_type           TEXT NOT NULL REFERENCES txn_type_ref(txn_type_code),
  category_code      TEXT REFERENCES txn_category_ref(category_code),
  channel_code       TEXT NOT NULL REFERENCES channel_ref(channel_code),
  amount_minor       INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency           TEXT NOT NULL DEFAULT 'INR',
  dr_cr              TEXT NOT NULL CHECK (dr_cr IN ('D','C')),
  txn_ts             TEXT NOT NULL,
  posting_date       TEXT,
  status             TEXT NOT NULL CHECK (status IN
    ('PENDING','POSTED','REVERSED','REFUNDED','PARTIALLY_REFUNDED','FAILED')),
  refunded_minor     INTEGER NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  merchant_id        TEXT,
  merchant_name      TEXT,
  mcc                TEXT,
  original_txn_id    TEXT REFERENCES txn_master(txn_id),
  is_reversal        INTEGER NOT NULL DEFAULT 0 CHECK (is_reversal IN (0,1)),
  reference_no       TEXT,
  attributes_json    TEXT NOT NULL DEFAULT '{}', -- extensible attributes, no schema change needed
  first_event_id     TEXT NOT NULL,
  last_event_id      TEXT NOT NULL,
  ingested_at        TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  processing_status  TEXT NOT NULL DEFAULT 'PENDING_EVAL' CHECK (processing_status IN ('PENDING_EVAL','EVALUATED','FAILED')),
  last_evaluated_at  TEXT,
  recon_status       TEXT NOT NULL DEFAULT 'UNRECONCILED' CHECK (recon_status IN ('UNRECONCILED','MATCHED','MISMATCH')),
  recon_at           TEXT,
  UNIQUE (source_system, source_txn_id),
  CHECK (refunded_minor <= amount_minor)
);
CREATE INDEX ix_txn_customer_ts ON txn_master(customer_id, txn_ts);
CREATE INDEX ix_txn_account     ON txn_master(account_id, txn_ts);
CREATE INDEX ix_txn_original    ON txn_master(original_txn_id);
CREATE INDEX ix_txn_status      ON txn_master(status);
CREATE INDEX ix_txn_proc        ON txn_master(processing_status);

-- Financial fields are immutable. Only status progression, refunded amount,
-- processing/reconciliation markers and (while PENDING) the amount may change.
CREATE TRIGGER trg_txn_master_immutable
BEFORE UPDATE ON txn_master
WHEN NEW.txn_id <> OLD.txn_id
  OR NEW.source_system <> OLD.source_system
  OR NEW.source_txn_id <> OLD.source_txn_id
  OR NEW.customer_id <> OLD.customer_id
  OR NEW.dr_cr <> OLD.dr_cr
  OR NEW.txn_type <> OLD.txn_type
  OR NEW.is_reversal <> OLD.is_reversal
  OR (NEW.amount_minor <> OLD.amount_minor AND OLD.status <> 'PENDING')
  OR IFNULL(NEW.original_txn_id,'') <> IFNULL(OLD.original_txn_id,'')
BEGIN
  SELECT RAISE(ABORT, 'txn_master financial fields are immutable');
END;

CREATE TRIGGER trg_txn_master_no_delete
BEFORE DELETE ON txn_master
BEGIN
  SELECT RAISE(ABORT, 'txn_master rows cannot be deleted');
END;

CREATE TABLE txn_status_history (
  history_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id         TEXT NOT NULL REFERENCES txn_master(txn_id),
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  refunded_minor INTEGER NOT NULL DEFAULT 0,
  event_id       TEXT NOT NULL,
  changed_at     TEXT NOT NULL
);
CREATE INDEX ix_txn_hist ON txn_status_history(txn_id);

-- Balance history. Balances are never inferred from transactions.
CREATE TABLE balance_snapshot (
  snapshot_id           TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES account(account_id),
  as_of_date            TEXT NOT NULL,
  closing_balance_minor INTEGER NOT NULL,       -- may be negative (overdraft)
  currency              TEXT NOT NULL DEFAULT 'INR',
  source_system         TEXT NOT NULL,
  event_id              TEXT NOT NULL,
  revision              INTEGER NOT NULL DEFAULT 1,
  ingested_at           TEXT NOT NULL,
  UNIQUE (account_id, as_of_date)
);
CREATE INDEX ix_bal_account_date ON balance_snapshot(account_id, as_of_date);

-- ---------- Campaigns and rules -------------------------------------
CREATE TABLE campaign (
  campaign_id     TEXT PRIMARY KEY,
  campaign_code   TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT,
  objective       TEXT,
  start_date      TEXT NOT NULL,
  end_date        TEXT NOT NULL,
  timezone        TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  points_budget   INTEGER CHECK (points_budget IS NULL OR points_budget >= 0),
  enrollment_mode TEXT NOT NULL DEFAULT 'AUTO' CHECK (enrollment_mode IN ('AUTO','OPT_IN')),
  status          TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','PAUSED','CLOSED')),
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (end_date >= start_date)
);

CREATE TABLE rule (
  rule_id    TEXT PRIMARY KEY,
  rule_code  TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE rule_version (
  rule_version_id   TEXT PRIMARY KEY,
  rule_id           TEXT NOT NULL REFERENCES rule(rule_id),
  version_no        INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
    ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','ACTIVE','PAUSED','SUPERSEDED','RETIRED')),
  name              TEXT NOT NULL,
  description       TEXT,
  business_objective TEXT,
  category          TEXT NOT NULL,
  campaign_id       TEXT REFERENCES campaign(campaign_id),
  kind              TEXT NOT NULL CHECK (kind IN ('GOAL','PER_EVENT','COMBINED')),
  metric_type       TEXT CHECK (metric_type IN ('COUNT','SUM','AVG_BALANCE','MIN_BALANCE','BALANCE_GROWTH')),
  metric_operator   TEXT NOT NULL DEFAULT 'GTE' CHECK (metric_operator IN ('GTE','GT')),
  period_type       TEXT NOT NULL CHECK (period_type IN ('DAILY','WEEKLY','MONTHLY','QUARTERLY','CAMPAIGN')),
  timezone          TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  date_basis        TEXT NOT NULL DEFAULT 'TXN_DATE' CHECK (date_basis IN ('TXN_DATE','POSTING_DATE')),
  late_grace_days   INTEGER NOT NULL DEFAULT 0 CHECK (late_grace_days >= 0),
  tier_mode         TEXT NOT NULL DEFAULT 'CUMULATIVE' CHECK (tier_mode IN ('CUMULATIVE','HIGHEST_ONLY')),
  frequency         TEXT NOT NULL DEFAULT 'RECURRING' CHECK (frequency IN ('ONCE','RECURRING')),
  max_occurrences   INTEGER CHECK (max_occurrences IS NULL OR max_occurrences > 0),
  cap_points_period INTEGER CHECK (cap_points_period IS NULL OR cap_points_period >= 0),
  cap_points_lifetime INTEGER CHECK (cap_points_lifetime IS NULL OR cap_points_lifetime >= 0),
  reversal_policy   TEXT NOT NULL DEFAULT 'CLAWBACK' CHECK (reversal_policy IN ('CLAWBACK','GRANDFATHER')),
  priority          INTEGER NOT NULL DEFAULT 100,
  conflict_group    TEXT,
  conflict_policy   TEXT NOT NULL DEFAULT 'CUMULATIVE' CHECK (conflict_policy IN ('CUMULATIVE','EXCLUSIVE_HIGHEST_POINTS','EXCLUSIVE_PRIORITY')),
  effective_from    TEXT,
  effective_to      TEXT,
  options_json      TEXT NOT NULL DEFAULT '{}',  -- countStatuses, scope, per-event reward, balance policy, nudges
  definition_hash   TEXT,                        -- sealed at submit; verified on every load
  change_note       TEXT,
  backfill          INTEGER NOT NULL DEFAULT 0 CHECK (backfill IN (0,1)),
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  submitted_by      TEXT,
  submitted_at      TEXT,
  approved_by       TEXT,
  approved_at       TEXT,
  rejected_reason   TEXT,
  activated_by      TEXT,
  activated_at      TEXT,
  UNIQUE (rule_id, version_no)
);
CREATE INDEX ix_rv_status ON rule_version(status);
CREATE INDEX ix_rv_campaign ON rule_version(campaign_id);

-- At most one ACTIVE or PAUSED version per rule.
CREATE UNIQUE INDEX ux_rv_one_live ON rule_version(rule_id) WHERE status IN ('ACTIVE','PAUSED');

CREATE TABLE rule_condition_group (
  group_id        TEXT PRIMARY KEY,
  rule_version_id TEXT NOT NULL REFERENCES rule_version(rule_version_id) ON DELETE CASCADE,
  parent_group_id TEXT REFERENCES rule_condition_group(group_id) ON DELETE CASCADE,
  purpose         TEXT NOT NULL CHECK (purpose IN ('ELIGIBILITY','QUALIFYING')),
  logical_op      TEXT NOT NULL CHECK (logical_op IN ('AND','OR')),
  negate          INTEGER NOT NULL DEFAULT 0 CHECK (negate IN (0,1)),
  seq             INTEGER NOT NULL
);
CREATE INDEX ix_rcg_version ON rule_condition_group(rule_version_id);

CREATE TABLE rule_condition (
  condition_id TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES rule_condition_group(group_id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  field        TEXT NOT NULL,                    -- e.g. txn.channel, txn.amount, customer.segments, account.product_code
  operator     TEXT NOT NULL CHECK (operator IN
    ('EQ','NE','GT','GTE','LT','LTE','IN','NOT_IN','BETWEEN','CONTAINS','STARTS_WITH','IS_NULL','NOT_NULL')),
  value_json   TEXT                               -- scalar, list, or [low, high]
);
CREATE INDEX ix_rc_group ON rule_condition(group_id);

CREATE TABLE rule_tier (
  tier_id         TEXT PRIMARY KEY,
  rule_version_id TEXT NOT NULL REFERENCES rule_version(rule_version_id) ON DELETE CASCADE,
  tier_no         INTEGER NOT NULL,
  label           TEXT,
  threshold       REAL NOT NULL,                  -- major units for money metrics, integer for COUNT
  points          INTEGER NOT NULL CHECK (points >= 0),
  UNIQUE (rule_version_id, tier_no)
);

CREATE TABLE rule_component (
  rule_version_id   TEXT NOT NULL REFERENCES rule_version(rule_version_id) ON DELETE CASCADE,
  component_rule_id TEXT NOT NULL REFERENCES rule(rule_id),
  min_tier_no       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (rule_version_id, component_rule_id)
);

-- ---------- Enrolment, progress and evaluation ----------------------
CREATE TABLE customer_enrollment (
  customer_id TEXT NOT NULL REFERENCES customer(customer_id),
  campaign_id TEXT NOT NULL REFERENCES campaign(campaign_id),
  status      TEXT NOT NULL CHECK (status IN ('ENROLLED','OPTED_OUT')),
  source      TEXT NOT NULL CHECK (source IN ('AUTO','OPT_IN','ADMIN')),
  enrolled_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, campaign_id)
);

-- Projection of in-period progress per customer, rule version and period.
CREATE TABLE goal_progress (
  progress_id     TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customer(customer_id),
  rule_id         TEXT NOT NULL REFERENCES rule(rule_id),
  rule_version_id TEXT NOT NULL REFERENCES rule_version(rule_version_id),
  period_key      TEXT NOT NULL,
  period_start    TEXT NOT NULL,
  period_end      TEXT NOT NULL,
  txn_count       INTEGER NOT NULL DEFAULT 0,
  txn_sum_minor   INTEGER NOT NULL DEFAULT 0,
  metric_value    INTEGER NOT NULL DEFAULT 0,    -- COUNT, or minor units for money metrics
  achieved_tier   INTEGER NOT NULL DEFAULT 0,    -- highest tier whose threshold is met
  status          TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN
    ('IN_PROGRESS','ACHIEVED','CLOSED_ACHIEVED','CLOSED_NOT_ACHIEVED','CLOSED_SUPERSEDED','DATA_UNAVAILABLE')),
  data_note       TEXT,
  last_txn_id     TEXT,
  updated_at      TEXT NOT NULL,
  UNIQUE (customer_id, rule_version_id, period_key)
);
CREATE INDEX ix_gp_rule ON goal_progress(rule_id, period_key);
CREATE INDEX ix_gp_open ON goal_progress(status, period_end);

-- Append-only journal behind goal_progress. Reversals are new rows.
CREATE TABLE goal_contribution (
  contribution_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id       TEXT NOT NULL,
  rule_version_id   TEXT NOT NULL REFERENCES rule_version(rule_version_id),
  period_key        TEXT NOT NULL,
  txn_id            TEXT NOT NULL REFERENCES txn_master(txn_id),
  entry_type        TEXT NOT NULL CHECK (entry_type IN ('APPLY','REVERSE')),
  amount_delta_minor INTEGER NOT NULL,
  count_delta       INTEGER NOT NULL,
  event_id          TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX ix_gc_txn ON goal_contribution(txn_id, rule_version_id, period_key);
CREATE INDEX ix_gc_progress ON goal_contribution(customer_id, rule_version_id, period_key);

CREATE TRIGGER trg_gc_no_update BEFORE UPDATE ON goal_contribution
BEGIN SELECT RAISE(ABORT, 'goal_contribution is append-only'); END;
CREATE TRIGGER trg_gc_no_delete BEFORE DELETE ON goal_contribution
BEGIN SELECT RAISE(ABORT, 'goal_contribution is append-only'); END;

CREATE TABLE rule_evaluation (
  evaluation_id    TEXT PRIMARY KEY,
  trigger_event_id TEXT,
  trigger_kind     TEXT NOT NULL CHECK (trigger_kind IN ('TXN','SNAPSHOT','PERIOD_CLOSE','REPLAY','COMBINED')),
  txn_id           TEXT,
  customer_id      TEXT NOT NULL,
  rule_id          TEXT NOT NULL,
  rule_version_id  TEXT NOT NULL,
  period_key       TEXT,
  evaluated_at     TEXT NOT NULL,
  outcome          TEXT NOT NULL CHECK (outcome IN
    ('INELIGIBLE','NOT_QUALIFYING','IN_PROGRESS','ACHIEVED','AWARDED','REVERSED','NO_CHANGE',
     'CAPPED','SUPPRESSED','DATA_UNAVAILABLE','PERIOD_CLOSED','ERROR')),
  eligible         INTEGER NOT NULL,
  metric_value     INTEGER,
  points_target    INTEGER,
  points_delta     INTEGER NOT NULL DEFAULT 0,
  reason_code      TEXT,
  reason_text      TEXT,
  trace_json       TEXT
);
CREATE INDEX ix_re_customer ON rule_evaluation(customer_id, evaluated_at);
CREATE INDEX ix_re_rule     ON rule_evaluation(rule_id, evaluated_at);
CREATE INDEX ix_re_txn      ON rule_evaluation(txn_id);
CREATE INDEX ix_re_outcome  ON rule_evaluation(outcome);

-- ---------- XP ledger (immutable) and reward adjustments ------------
CREATE TABLE xp_ledger (
  ledger_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id       TEXT NOT NULL REFERENCES customer(customer_id),
  entry_type        TEXT NOT NULL CHECK (entry_type IN ('AWARD','REVERSAL','ADJUSTMENT')),
  points            INTEGER NOT NULL CHECK (points <> 0),
  rule_id           TEXT REFERENCES rule(rule_id),
  rule_version_id   TEXT REFERENCES rule_version(rule_version_id),
  campaign_id       TEXT REFERENCES campaign(campaign_id),
  period_key        TEXT,
  slot              TEXT,                         -- tier:N, best, or txn:<id>
  tier_no           INTEGER,
  source_txn_id     TEXT,
  source_event_id   TEXT,
  evaluation_id     TEXT,
  reverses_ledger_id INTEGER REFERENCES xp_ledger(ledger_id),
  adjustment_id     TEXT,
  reason_code       TEXT NOT NULL,
  reason_text       TEXT,
  idempotency_key   TEXT NOT NULL UNIQUE,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  CHECK (
    (entry_type = 'AWARD'      AND points > 0 AND reverses_ledger_id IS NULL) OR
    (entry_type = 'REVERSAL'   AND points < 0 AND reverses_ledger_id IS NOT NULL) OR
    (entry_type = 'ADJUSTMENT')
  )
);
CREATE INDEX ix_xl_customer ON xp_ledger(customer_id, ledger_id);
CREATE INDEX ix_xl_slot     ON xp_ledger(customer_id, rule_id, period_key, slot);
CREATE INDEX ix_xl_rule     ON xp_ledger(rule_id, customer_id);
CREATE INDEX ix_xl_campaign ON xp_ledger(campaign_id);
CREATE INDEX ix_xl_reverses ON xp_ledger(reverses_ledger_id);
CREATE INDEX ix_xl_txn      ON xp_ledger(source_txn_id);

CREATE TRIGGER trg_xl_no_update BEFORE UPDATE ON xp_ledger
BEGIN SELECT RAISE(ABORT, 'xp_ledger is immutable: post a reversal or adjustment instead'); END;
CREATE TRIGGER trg_xl_no_delete BEFORE DELETE ON xp_ledger
BEGIN SELECT RAISE(ABORT, 'xp_ledger is immutable: post a reversal or adjustment instead'); END;

-- Projection of SUM(xp_ledger.points). Reconciled daily.
CREATE TABLE xp_account (
  customer_id       TEXT PRIMARY KEY REFERENCES customer(customer_id),
  balance           INTEGER NOT NULL DEFAULT 0,
  lifetime_earned   INTEGER NOT NULL DEFAULT 0,
  lifetime_reversed INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL
);

CREATE TABLE reward_adjustment (
  adjustment_id TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customer(customer_id),
  points        INTEGER NOT NULL CHECK (points <> 0),
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('REQUESTED','APPROVED','REJECTED')),
  requested_by  TEXT NOT NULL,
  requested_at  TEXT NOT NULL,
  decided_by    TEXT,
  decided_at    TEXT,
  decision_note TEXT,
  ledger_id     INTEGER REFERENCES xp_ledger(ledger_id)
);

-- ---------- Nudges ---------------------------------------------------
CREATE TABLE nudge_template (
  template_code TEXT PRIMARY KEY,
  nudge_type    TEXT NOT NULL CHECK (nudge_type IN ('PROGRESS','NEAR_TARGET','TIER_ACHIEVED','REWARD_REVERSED')),
  channel       TEXT NOT NULL CHECK (channel IN ('PUSH','IN_APP','SMS','EMAIL','WHATSAPP')),
  body_template TEXT NOT NULL,                   -- tokens: {{goal}} {{points}} {{remaining}} {{progress}} {{target}}
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE nudge (
  nudge_id        TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customer(customer_id),
  rule_id         TEXT REFERENCES rule(rule_id),
  rule_version_id TEXT,
  period_key      TEXT,
  nudge_type      TEXT NOT NULL CHECK (nudge_type IN ('PROGRESS','NEAR_TARGET','TIER_ACHIEVED','REWARD_REVERSED')),
  channel         TEXT NOT NULL,
  message         TEXT NOT NULL,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  dedupe_key      TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('ELIGIBLE','SENT','SUPPRESSED','FAILED')),
  suppress_reason TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  sent_at         TEXT
);
CREATE INDEX ix_nudge_customer ON nudge(customer_id, created_at);
CREATE INDEX ix_nudge_status   ON nudge(status);

-- ---------- Administration, audit, reconciliation -------------------
CREATE TABLE app_user (
  user_id       TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE user_role (
  user_id   TEXT NOT NULL REFERENCES app_user(user_id),
  role_code TEXT NOT NULL CHECK (role_code IN ('RULE_MAKER','RULE_APPROVER','QA_ENGINEER','OPERATIONS','AUDITOR','SYSTEM_ADMIN')),
  PRIMARY KEY (user_id, role_code)
);

CREATE TABLE api_client (
  client_id     TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  key_hash      TEXT NOT NULL,
  scopes        TEXT NOT NULL DEFAULT 'ingest',
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    TEXT NOT NULL
);

CREATE TABLE system_config (
  config_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Hash-chained, append-only: each row commits to the previous row.
CREATE TABLE audit_log (
  audit_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at    TEXT NOT NULL,
  actor          TEXT NOT NULL,
  actor_roles    TEXT,
  action         TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  before_json    TEXT,
  after_json     TEXT,
  reason         TEXT,
  correlation_id TEXT,
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL
);
CREATE INDEX ix_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX ix_audit_time   ON audit_log(occurred_at);
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TABLE reconciliation_run (
  run_id      TEXT PRIMARY KEY,
  run_type    TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL CHECK (status IN ('RUNNING','PASSED','FAILED')),
  checked     INTEGER NOT NULL DEFAULT 0,
  breaks      INTEGER NOT NULL DEFAULT 0,
  run_by      TEXT NOT NULL
);

CREATE TABLE reconciliation_break (
  break_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES reconciliation_run(run_id),
  break_type  TEXT NOT NULL,
  entity_ref  TEXT NOT NULL,
  expected    TEXT,
  actual      TEXT,
  detail      TEXT,
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED'))
);
CREATE INDEX ix_rb_run ON reconciliation_break(run_id);
