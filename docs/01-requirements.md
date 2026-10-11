# 01 – Business requirements and functional specification

## 1. Purpose

Money XP (MXP) rewards customers with **XP points** for banking behaviour that is already visible in transaction data: spending on a card, paying by UPI, paying bills, keeping and growing balances. Business teams configure goals as **data**; the platform evaluates them against a central **transaction master** and posts rewards to an **immutable ledger**, then nudges customers towards their next goal.

MXP **never posts to or alters financial transactions**. It reads copies of transactions that source systems send it, and writes only to its own tables.

## 2. Actors

| Actor | Role code | Needs |
|---|---|---|
| Product / campaign owner | `RULE_MAKER` | Create and edit campaigns and rule drafts; run simulations |
| Risk / business approver | `RULE_APPROVER` | Review, approve or reject; approve manual adjustments |
| QA engineer | `QA_ENGINEER` | Build scenarios, matrix runs, regression suites in the Testing app |
| Operations | `OPERATIONS` | Ingestion health, replay, reconciliation, activate / pause, request adjustments, exports |
| Auditor | `AUDITOR` | Read-only access to everything including the audit log; exports |
| System administrator | `SYSTEM_ADMIN` | Users, API keys, engine configuration, customer import |
| Source systems | API key | Deliver transactions and balance snapshots |
| Customer | – | Receives nudges and sees XP (customer-facing app is out of scope for Phase 1) |

## 3. Business use cases (all configurable, none hard-coded)

| # | Use case | How it is expressed | Sample rule |
|---|---|---|---|
| 1 | Average monthly savings balance ≥ ₹50,000 → 500 XP | `GOAL`, metric `AVG_BALANCE`, monthly, one tier | `SAV_AVG_BAL_50K` |
| 2 | Card spend ≥ ₹10,000 in a month → 300 XP (plus a higher tier) | `GOAL`, metric `SUM`, qualifying = card purchases, tiers 10k→300 and 25k→400 | `CARD_SPEND_10K` |
| 3 | 10 eligible UPI payments in a month → 100 XP | `GOAL`, metric `COUNT`, self-transfers and amounts under ₹10 excluded | `UPI_10_TXNS` |
| 4 | Three utility bill payments in a campaign period → bonus | `GOAL`, `COUNT`, period `CAMPAIGN`, tiers 3→150 and 6→250 | `UTILITY_3_BILLS` |
| 5 | Savings growth by ₹25,000 → points | `GOAL`, metric `BALANCE_GROWTH` | `SAV_GROWTH_25K` |
| 6 | Combined goals (balance **and** card spend) → higher tier | `COMBINED` of use cases 1 and 2 | `BALANCE_PLUS_CARD` |
| – | 1 XP per ₹100 on merchant UPI, capped at 200 XP a month | `PER_EVENT`, `PER_AMOUNT`, monthly cap | `UPI_MERCHANT_PER_TXN` |

Everything that varies is a parameter: thresholds, periods, tiers, points, products, channels, categories, exclusions, caps, frequency, dates, priority and conflict handling.

## 4. Functional requirements

Priority: **M** must (Phase 1), **S** should. Each requirement is covered by at least one automated test (see [09](09-testing-strategy.md)).

### 4.1 Transaction master and ingestion
- **F-01 (M)** One canonical transaction master for all channels; extensible attributes without schema change (`attributes_json`).
- **F-02 (M)** Source adapters deliver events in a canonical envelope (`TRANSACTION`, `BALANCE_SNAPSHOT`) via API or batch.
- **F-03 (M)** Validate (schema, reference data, customer/account/instrument existence, future timestamps), normalise (money to minor units, timestamps to UTC with a business date in the rule time zone) and de-duplicate on `(source_system, source_event_id)` and `(source_system, source_txn_id)`.
- **F-04 (M)** The same event id with different content is a `CONFLICTING_DUPLICATE` and is rejected, not applied.
- **F-05 (M)** Unknown customer or account is retried with exponential back-off (`SUSPENDED`), then dead-lettered after `maxAttempts`; every stage is recorded in the event history and can be replayed.
- **F-06 (M)** Status transitions are forward-only: pending → posted → reversed / refunded / partially refunded; failed. Refunds and reversals link to the original transaction.
- **F-07 (M)** Batch files carry control totals; closing a batch reports `RECONCILED` or `MISMATCH`.
- **F-08 (M)** Balances come from **daily closing balance snapshots**, never inferred from transactions. Revisions are kept.

### 4.2 Rules engine
- **F-10 (M)** Rule kinds: `GOAL` (count, sum, average balance, minimum balance, balance growth), `PER_EVENT` (fixed or per-amount points), `COMBINED` (number of component goals met).
- **F-11 (M)** Condition trees with nested AND / OR groups and negation over `txn.*`, `account.*`, `customer.*` and `txn.attr.<key>`; 13 operators (EQ, NE, GT, GTE, LT, LTE, IN, NOT_IN, BETWEEN, CONTAINS, STARTS_WITH, IS_NULL, NOT_NULL). Separate **eligibility** (who) and **qualifying** (what counts) groups.
- **F-12 (M)** Periods: daily, weekly, monthly, quarterly, campaign; time zone per rule; transaction date or posting date basis; late-arrival grace days.
- **F-13 (M)** Tiers with `CUMULATIVE` (each tier adds) or `HIGHEST_ONLY` modes.
- **F-14 (M)** Limits: once or recurring, max occurrences, points cap per period, lifetime cap, campaign budget.
- **F-15 (M)** Priority and conflict groups with policies `CUMULATIVE`, `EXCLUSIVE_HIGHEST_POINTS`, `EXCLUSIVE_PRIORITY`.
- **F-16 (M)** Reversal handling per rule: `CLAWBACK` (withdraw points when a qualifying transaction is reversed or refunded below the threshold) or `GRANDFATHER`.
- **F-17 (M)** Which transaction statuses count (`POSTED`, optionally `PENDING`).
- **F-18 (M)** Effective dates on rules and campaigns; transactions outside the window never count.
- **F-19 (M)** **Idempotent rewards**: the same facts processed any number of times, in any order, yield exactly the same ledger.
- **F-20 (M)** Honest data gaps: a balance goal with missing snapshots reports `DATA_UNAVAILABLE` rather than guessing.

### 4.3 Rewards
- **F-30 (M)** Append-only XP ledger with `AWARD`, `REVERSAL`, `ADJUSTMENT`; each entry carries rule version, period, reason, idempotency key and links to the triggering evaluation and transaction.
- **F-31 (M)** Customer XP account (balance, lifetime earned, lifetime reversed) is a projection reconciled against the ledger.
- **F-32 (M)** Manual adjustments require a reason and a second person (maker-checker).
- **F-33 (M)** Rewards for a closed period are never created by late data (the metric is still updated).

### 4.4 Nudges
- **F-40 (M)** Generate `PROGRESS`, `NEAR_TARGET`, `TIER_ACHIEVED`, `REWARD_REVERSED` nudges from goal progress.
- **F-41 (M)** Only approved channels, only with customer consent, daily cap per customer, de-duplicated; suppressed nudges record why.
- **F-42 (S)** Delivery goes through an adapter; Phase 1 ships a logging adapter.

### 4.5 Admin Console
- **F-50 (M)** Dashboard: awards, reversals, active rules, pending approvals, ingestion health, reconciliation status.
- **F-51 (M)** Rule builder with live validation messages, condition-tree editor, tier editor, and a plain-language description.
- **F-52 (M)** Lifecycle: draft → validate → simulate → submit → approve → activate → pause / resume → retire; reject; roll back.
- **F-53 (M)** Version history, side-by-side diff, rollback with reason.
- **F-54 (M)** Maker-checker: the person who created or submitted a version can never approve it.
- **F-55 (M)** RBAC with the six roles above; every state change is audited.
- **F-56 (M)** Evaluation search with full trace, ledger search, customer 360, CSV export (audited).
- **F-57 (M)** Campaigns, ingestion monitor (events, history, replay, batches), reconciliation, audit viewer with chain verification, user / API-key / configuration administration.

### 4.6 Testing and Simulation app
- **F-60 (M)** Separate responsive app; select rule, campaign, version (including an unsaved draft) and a synthetic or real-history customer.
- **F-61 (M)** Scenario language covering transactions, status changes, reversals, refunds, balance snapshots and period close; duplicate deliveries; overlapping rules.
- **F-62 (M)** Single-rule and multi-rule runs; auto-generated **scenario matrix** (positive, negative, boundary, eligibility, duplicate, reversal, refund, status, period, regression); performance runs.
- **F-63 (M)** Save, clone, rerun cases; suites with history; expected vs actual per check.
- **F-64 (M)** Per run: inputs, rules and versions, per-condition pass/fail with reasons, XP, progress before/after, caps, exclusions, conflicts, full trace, errors, downloadable CSV.
- **F-65 (M)** **Production isolation**: simulations run in a throw-away in-memory database with the same engine code; production data is read-only; results are stored in a separate simulation database.

### 4.7 Operations and compliance
- **F-70 (M)** Reconciliation: ledger vs XP account, progress vs journal, journal vs master, reversal integrity, stuck pipeline, dead letters, batch control, campaign budget, audit chain; optional source reconciliation.
- **F-71 (M)** Period close, rule backfill and event replay are idempotent operator actions.
- **F-72 (M)** Immutable audit log, hash-chained and tamper-evident.

## 5. Non-functional requirements

| Area | Requirement | How it is met |
|---|---|---|
| Correctness | No duplicate or lost rewards | Idempotency keys, convergent award algorithm, forward-only transitions, tests ([04](04-rules-and-evaluation.md)) |
| Performance | Never scan the whole transaction table per rule | Transaction-driven evaluation, incremental `goal_progress`, journal; see [02](02-architecture.md) |
| Security | Authentication, authorisation, encryption, masking, secrets | [10](10-deployment-security-runbooks.md) |
| Auditability | Who changed what, when, and why | Hash-chained audit log; sealed rule hashes |
| Availability | Retry, DLQ, restartable worker, DR | Event store is the queue; replay; runbooks |
| Observability | Health, readiness, reconciliation, structured logs | `/api/health`, `/api/ready`, `/api/ops/health`, correlation ids |
| Environments | Dev / test / staging / prod separation | `MXP_ENV`, no demo data in prod, strong JWT secret enforced |
| Change control | Controlled activation and rollback | Maker-checker, one open version per rule, rollback |
| Privacy | Data minimisation | Tokens and masked names only; no PAN, account numbers or raw PII |

## 6. Out of scope (Phase 1)

Customer-facing app and redemption/catalogue; real SMS/push providers (adapter interface only); SSO/IdP integration; multi-currency; streaming infrastructure (Kafka). The design leaves a clear seam for each; see [02](02-architecture.md) and [10](10-deployment-security-runbooks.md).

## 7. Acceptance scenario

> An admin creates a goal, configures conditions and XP, tests it against scenarios, has it approved and activated, and verifies correct rewards with no duplicates.

This is exercised end to end by `apps/server/test/admin-journey.e2e.test.ts` and, with the shipped sample data, by `apps/server/test/samples.e2e.test.ts`.
