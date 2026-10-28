-- =====================================================================
-- MXP v5 schema (account-centric, DWH-fed).
--
-- vs v4: spend_control_breach removed — breaches live in rule_evaluation
--        (outcome = 'BREACH'; target_value = limit, measure_after = measured).
--
-- Templates live as JSON files in @mxp/rules (not in the database).
-- =====================================================================

-- ---------- 1. Reference data ----------------------------------------
CREATE TABLE segment (
  segment_code TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE reference_value (
  list_code  TEXT NOT NULL,
  value_code TEXT NOT NULL,
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (list_code, value_code)
);

CREATE TABLE merchant (
  merchant_id   TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  category_code TEXT NOT NULL,
  mcc           TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

-- ---------- 2. Customers / accounts ----------------------------------
CREATE TABLE customer (
  customer_id     TEXT PRIMARY KEY,
  customer_ref    TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  segment_code    TEXT NOT NULL REFERENCES segment(segment_code),
  state_code      TEXT,
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','BLOCKED','CLOSED')),
  kyc_status      TEXT NOT NULL DEFAULT 'FULL' CHECK (kyc_status IN ('FULL','MINIMAL','PENDING')),
  timezone        TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  dormancy_risk   INTEGER NOT NULL DEFAULT 0 CHECK (dormancy_risk IN (0,1)),
  attributes_json TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX ix_customer_segment ON customer(segment_code);
CREATE INDEX ix_customer_state ON customer(state_code);

CREATE TABLE account (
  account_id     TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customer(customer_id),
  account_ref    TEXT NOT NULL UNIQUE,
  account_type   TEXT NOT NULL,
  product_family TEXT NOT NULL,
  product_code   TEXT,
  state_code     TEXT,
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DORMANT','FROZEN','CLOSED')),
  opened_on      TEXT NOT NULL,
  closed_on      TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX ix_account_customer ON account(customer_id);
CREATE INDEX ix_account_product ON account(product_family);

-- ---------- 3. Bank rules --------------------------------------------
-- Family: MISSION (select/enroll only) | SPEND_CONTROL (customer setting values → points)
-- product_scope: ANY | CASA | CREDIT_CARD
CREATE TABLE rule (
  rule_code       TEXT PRIMARY KEY,
  family          TEXT NOT NULL CHECK (family IN ('MISSION','SPEND_CONTROL')),
  template_code   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','PAUSED','RETIRED')),
  name            TEXT NOT NULL,
  description     TEXT,
  enrollment_mode TEXT NOT NULL DEFAULT 'AUTO' CHECK (enrollment_mode IN ('AUTO','OPT_IN')),
  product_scope   TEXT NOT NULL DEFAULT 'ANY' CHECK (product_scope IN ('ANY','CASA','CREDIT_CARD')),
  effective_from  TEXT,
  effective_to    TEXT,
  priority        INTEGER NOT NULL DEFAULT 100,
  featured        INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX ix_rule_family ON rule(family, status);
CREATE INDEX ix_rule_dates ON rule(effective_from, effective_to);

-- ---------- 4. Participation -----------------------------------------
CREATE TABLE customer_setting (
  setting_id          TEXT PRIMARY KEY,
  customer_id         TEXT NOT NULL REFERENCES customer(customer_id),
  rule_code           TEXT NOT NULL REFERENCES rule(rule_code),
  values_json         TEXT NOT NULL,
  effective_from      TEXT NOT NULL,
  pending_values_json TEXT,
  pending_from        TEXT,
  status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  created_via         TEXT NOT NULL DEFAULT 'APP',
  updated_at          TEXT NOT NULL,
  cancelled_at        TEXT,
  UNIQUE (customer_id, rule_code)
);
CREATE INDEX ix_setting_rule ON customer_setting(rule_code, status);

CREATE TABLE mission_enrollment (
  customer_id  TEXT NOT NULL REFERENCES customer(customer_id),
  rule_code    TEXT NOT NULL REFERENCES rule(rule_code),
  status       TEXT NOT NULL CHECK (status IN ('ENROLLED','OPTED_OUT')),
  source       TEXT NOT NULL,
  enrolled_at  TEXT NOT NULL,
  opted_out_at TEXT,
  PRIMARY KEY (customer_id, rule_code)
);

-- ---------- 5. DWH batch + runtime -----------------------------------
CREATE TABLE dwh_batch (
  batch_id      TEXT PRIMARY KEY,
  business_date TEXT NOT NULL,
  source_system TEXT NOT NULL DEFAULT 'DWH',
  row_count     INTEGER NOT NULL DEFAULT 0,
  inserted      INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  error_text    TEXT
);
CREATE INDEX ix_dwh_batch_date ON dwh_batch(business_date);

CREATE TABLE "transaction" (
  event_id        TEXT PRIMARY KEY,
  source_system   TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  customer_id     TEXT NOT NULL REFERENCES customer(customer_id),
  account_id      TEXT NOT NULL REFERENCES account(account_id),
  occurred_at     TEXT NOT NULL,
  reversal_of     TEXT,
  payload_json    TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('RECEIVED','PROCESSED','FAILED')),
  processed_at    TEXT,
  error_text      TEXT,
  pack_hash       TEXT,
  dwh_batch_id    TEXT REFERENCES dwh_batch(batch_id),
  source_channel  TEXT,
  UNIQUE (source_system, source_event_id)
);
CREATE INDEX ix_transaction_account ON "transaction"(account_id, occurred_at);
CREATE INDEX ix_transaction_customer ON "transaction"(customer_id, occurred_at);
CREATE INDEX ix_transaction_type ON "transaction"(event_type, occurred_at);
CREATE INDEX ix_transaction_batch ON "transaction"(dwh_batch_id);

CREATE TABLE rule_state (
  state_key   TEXT PRIMARY KEY,
  prefix      TEXT NOT NULL,
  rule_code   TEXT,
  customer_id TEXT,
  window_key  TEXT,
  close_after TEXT,
  status      TEXT,
  window_end  TEXT,
  state_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX ix_rule_state_due ON rule_state(prefix, status, close_after);
CREATE INDEX ix_rule_state_customer ON rule_state(customer_id, rule_code);

CREATE TABLE control_decision (
  decision_id  TEXT PRIMARY KEY,
  request_id   TEXT,
  customer_id  TEXT NOT NULL,
  account_id   TEXT,
  event_type   TEXT NOT NULL,
  amount_minor INTEGER,
  payload_json TEXT NOT NULL,
  decision     TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  pack_hash    TEXT,
  decided_at   TEXT NOT NULL,
  latency_ms   REAL
);

CREATE TABLE rule_evaluation (
  evaluation_id   TEXT PRIMARY KEY,
  event_id        TEXT,
  trigger_kind    TEXT NOT NULL,
  rule_code       TEXT NOT NULL,
  rule_version_no INTEGER NOT NULL DEFAULT 1,
  family          TEXT NOT NULL,
  customer_id     TEXT NOT NULL,
  account_id      TEXT,
  subject_key     TEXT NOT NULL,
  setting_id      TEXT,
  window_key      TEXT,
  outcome         TEXT NOT NULL,
  decision        TEXT,
  measure_before  REAL,
  measure_after   REAL,
  target_value    REAL,
  points          INTEGER NOT NULL DEFAULT 0,
  message         TEXT,
  trace_json      TEXT,
  pack_hash       TEXT,
  evaluated_at    TEXT NOT NULL
);
CREATE INDEX ix_eval_customer ON rule_evaluation(customer_id, evaluated_at);
CREATE INDEX ix_eval_account ON rule_evaluation(account_id, evaluated_at);
CREATE INDEX ix_eval_rule ON rule_evaluation(rule_code, evaluated_at);

-- Points accumulate at account level; customer_id is denormalized for reporting.
-- Limit breaches are rule_evaluation rows with outcome = 'BREACH'
-- (target_value = limit, measure_after = measured, decision = ALERT|BLOCK).
CREATE TABLE points_ledger (
  ledger_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      TEXT NOT NULL REFERENCES account(account_id),
  customer_id     TEXT NOT NULL REFERENCES customer(customer_id),
  entry_type      TEXT NOT NULL CHECK (entry_type IN ('AWARD','CLAWBACK','ADJUSTMENT')),
  points          INTEGER NOT NULL,
  family          TEXT,
  rule_code       TEXT,
  rule_version_no INTEGER,
  window_key      TEXT,
  slot            TEXT,
  event_id        TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  reason          TEXT,
  earned_on       TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX ix_pl_account ON points_ledger(account_id, earned_on);
CREATE INDEX ix_pl_customer ON points_ledger(customer_id, earned_on);
CREATE INDEX ix_pl_earned ON points_ledger(earned_on);

CREATE TABLE points_account (
  account_id       TEXT PRIMARY KEY REFERENCES account(account_id),
  customer_id      TEXT NOT NULL REFERENCES customer(customer_id),
  balance          INTEGER NOT NULL DEFAULT 0,
  lifetime_earned  INTEGER NOT NULL DEFAULT 0,
  lifetime_clawed  INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL
);
CREATE INDEX ix_pa_customer ON points_account(customer_id);

CREATE TABLE nudge (
  nudge_id    TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  account_id  TEXT,
  rule_code   TEXT,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'PENDING',
  created_at  TEXT NOT NULL,
  sent_at     TEXT
);
CREATE INDEX ix_nudge_customer ON nudge(customer_id, created_at);

-- ---------- 6. Testing / governance ----------------------------------
CREATE TABLE test_scenario (
  scenario_id      TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT,
  focus_rule_code  TEXT,
  tags             TEXT,
  definition_json  TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_status      TEXT,
  last_run_at      TEXT
);

CREATE TABLE test_run (
  run_id      TEXT PRIMARY KEY,
  scenario_id TEXT REFERENCES test_scenario(scenario_id),
  run_kind    TEXT NOT NULL,
  pack_source TEXT NOT NULL,
  pack_hash   TEXT,
  passed      INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  run_by      TEXT NOT NULL,
  run_at      TEXT NOT NULL
);

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
  role_code TEXT NOT NULL,
  PRIMARY KEY (user_id, role_code)
);

CREATE TABLE audit_log (
  audit_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at  TEXT NOT NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  detail_json  TEXT,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);

CREATE TRIGGER trg_pl_no_update BEFORE UPDATE ON points_ledger BEGIN
  SELECT RAISE(ABORT, 'points_ledger is immutable');
END;
CREATE TRIGGER trg_pl_no_delete BEFORE DELETE ON points_ledger BEGIN
  SELECT RAISE(ABORT, 'points_ledger is immutable');
END;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER trg_eval_no_update BEFORE UPDATE ON rule_evaluation BEGIN
  SELECT RAISE(ABORT, 'rule_evaluation is append-only');
END;
CREATE TRIGGER trg_eval_no_delete BEFORE DELETE ON rule_evaluation BEGIN
  SELECT RAISE(ABORT, 'rule_evaluation is append-only');
END;
