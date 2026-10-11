# 05 – API contracts

All endpoints are under **`/api`**, JSON in and out (UTF-8), except CSV downloads.

* **Authentication:** `Authorization: Bearer <JWT>` from `POST /api/auth/login`. Source systems may instead send `x-api-key: mxp_…` to **`POST /api/ingest` only**.
* **Errors:** every error has the same shape and an appropriate status.

```json
{ "error": { "code": "VALIDATION", "message": "The request is invalid.", "details": [ { "path": "tiers.1.threshold", "message": "Tier thresholds must increase." } ] } }
```

| Status | Meaning | Typical `code` |
|---|---|---|
| 401 | Missing / invalid token or key, bad credentials | `UNAUTHENTICATED`, `BAD_CREDENTIALS` |
| 403 | Role lacks the permission, maker-checker violation | `FORBIDDEN`, `MAKER_CHECKER`, `NOT_OWNER` |
| 404 | Unknown resource | `NOT_FOUND` |
| 409 | State conflict | `OPEN_VERSION_EXISTS`, `DUPLICATE`, `DUPLICATE_CODE`, `SELF_LOCKOUT`, invalid transition |
| 422 | Validation failed | `VALIDATION`, rule validation errors |
| 423 | Account locked | `LOCKED` |
| 429 | Rate limited | – |
| 500 | Unexpected; no internals exposed, the response carries `requestId` to quote | `INTERNAL` |

* **Pagination:** list endpoints accept `limit` (default 50, max 500) and `offset`; they return `{ rows, total }`.
* **Dates / amounts:** ISO-8601 with offset (`2026-10-05T10:00:00+05:30`); money in major units as number or decimal string (up to 2 decimals) on input; the database stores minor units.
* **Rate limits:** login 10/min per client; ingest 3,000/min; everything else `MXP_RATE_LIMIT` (default 600/min).
* **Security headers** on every response; `Cache-Control: no-store` on API responses.

## 1. Public

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ status: "ok", time }` liveness |
| GET | `/api/ready` | `{ status: "ready" }` after a database round trip; 503 otherwise |
| POST | `/api/auth/login` | `{ username, password }` → `{ token, user: { username, name, roles, permissions } }`; 5 failures lock for 15 min |

## 2. Session and administration

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/auth/me` | any | current user |
| POST | `/api/auth/logout` | any | audited |
| POST | `/api/auth/password` | any | `{ current, password }`; ≥10 chars, upper, lower, digit |
| GET | `/api/meta` | any | field catalogue, operators, enums, reference data for the builders |
| GET / POST | `/api/admin/users` | `users:admin` | create `{ username, name, roles[], password }` |
| PATCH | `/api/admin/users/:username` | `users:admin` | `{ roles?, active?, unlock?, name? }`; cannot disable or demote yourself |
| POST | `/api/admin/users/:username/password` | `users:admin` | reset |
| GET / POST | `/api/admin/clients` | `users:admin` | create `{ sourceSystem }` → `{ clientId, apiKey }` (**shown once**) |
| DELETE | `/api/admin/clients/:id` | `users:admin` | revoke |
| GET / PUT | `/api/admin/config` | read: any; write: `users:admin` | `{ maxAttempts, retryBaseSeconds, futureToleranceMinutes, nudge: { approvedChannels, defaultChannel, dailyProgressCap }, storeTrace }` |
| POST | `/api/admin/customers/import` | `users:admin` | `{ customers: [ { ref, name, segments[], consent?, accounts[], instruments[] } ] }` → `{ submitted, created, skipped }`; unknown reference data → 422 |

## 3. Rules and campaigns

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/rules` | `rules:read` | list with live status, points issued, customers rewarded |
| POST | `/api/rules/validate` | `rules:read` | `{ definition }` → `{ valid, errors[], warnings[], description }`, with no side effects |
| POST | `/api/rules` | `rules:write` | `{ code, definition, changeNote? }` creates rule + draft v1 (201) |
| GET | `/api/rules/:code` | `rules:read` | versions, live version, stats |
| GET | `/api/rules/:code/versions/:v` | `rules:read` | full definition, status, who / when, hash |
| PUT | `/api/rules/:code/versions/:v` | `rules:write` | edit a **draft** (owner, or admin with audit) |
| POST | `/api/rules/:code/versions` | `rules:write` | new draft `{ baseVersionNo?, changeNote? }`; one open version at a time |
| POST | `…/versions/:v/validate` | `rules:read` | `{ activation? }` checks including activation readiness |
| POST | `…/versions/:v/submit` | `rules:write` | validates, seals the definition hash |
| POST | `…/versions/:v/approve` | `rules:approve` | `{ note? }`; not the creator or submitter |
| POST | `…/versions/:v/reject` | `rules:approve` | `{ reason }` ≥5 chars |
| POST | `…/versions/:v/activate` | `rules:activate` | `{ backfill? }`; supersedes the previous live version |
| POST | `…/versions/:v/pause` / `resume` / `retire` | `rules:activate` | `{ reason }` ≥5 chars (pause, retire) |
| POST | `/api/rules/:code/rollback` | `rules:activate` | `{ versionNo, reason }` re-activates a superseded version |
| GET | `/api/rules/:code/diff?from=1&to=2` | `rules:read` | structured field-level diff |
| GET / POST | `/api/campaigns` | read: `rules:read`; write: `campaigns:write` | |
| GET / PATCH | `/api/campaigns/:code` | same | PATCH is a partial update |
| POST | `/api/campaigns/:code/status` | `rules:activate` | `{ status: ACTIVE | PAUSED | CLOSED, reason? }` |

### Example: create, submit, approve, activate

```http
POST /api/rules
{ "code": "SPEND_2K", "changeNote": "Initial version", "definition": { ...see 04 } }
→ 201 { "ruleCode": "SPEND_2K", "versionNo": 1, "status": "DRAFT", ... }

POST /api/rules/SPEND_2K/versions/1/submit            (as maker)    → status PENDING_APPROVAL
POST /api/rules/SPEND_2K/versions/1/approve  {"note":"Reviewed"}   (as a different approver) → APPROVED
POST /api/rules/SPEND_2K/versions/1/activate {"backfill":false}    (as activator) → ACTIVE
```

## 4. Ingestion and operations

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/api/ingest` | `ops:write` or API key | `{ events[1..1000], batchId?, processNow? }` → `202 { summary, results[], work }`; `422` if every event was rejected |
| POST / GET | `/api/ingest/batches` | `ops:write` / `ops:read` | declare `{ sourceSystem, fileName?, controlCount?, controlAmount? }` |
| POST | `/api/ingest/batches/:id/close` | `ops:write` | `RECONCILED` or `MISMATCH` |
| GET | `/api/events` | `ops:read` | filters `status`, `source`, `q` |
| GET | `/api/events/:id` | `ops:read` | payload, history, linked transaction |
| POST | `/api/events/:id/replay` | `ops:write` | only for `REJECTED`, `FAILED`, `DEAD_LETTER`, `SUSPENDED` |
| POST | `/api/ops/process` | `ops:write` | drain the queue now |
| POST | `/api/ops/close-periods` | `ops:write` | close elapsed periods (idempotent) |
| POST | `/api/ops/rules/:code/backfill` | `ops:write` | replay the master for the open period (idempotent) |
| POST | `/api/ops/nudges/dispatch` | `ops:write` | send eligible nudges through the adapter |
| POST | `/api/ops/reconcile` | `ops:write` | internal checks → `{ status, breaks[] }` |
| POST | `/api/ops/reconcile-source` | `ops:write` | compare with a control extract `{ entries[{sourceTxnId, amount, status}] }` |
| GET | `/api/ops/reconciliation` | `ops:read` | run history and breaks |
| GET | `/api/ops/health` | `ops:read` | queue depth, stuck, dead letters, last reconciliation |

### Event envelope

```json
{ "eventType": "TRANSACTION", "sourceSystem": "CARDS", "sourceEventId": "9812:POSTED",
  "transaction": {
    "sourceTxnId": "9812", "customerRef": "CUST-1001", "accountRef": "CCA-1001", "instrumentRef": "CARD-1001",
    "txnType": "PURCHASE", "categoryCode": "DINING", "channel": "CARD_POS",
    "amount": 4200.00, "currency": "INR", "drCr": "D", "status": "POSTED",
    "txnTimestamp": "2026-10-01T11:30:00+05:30", "merchantName": "…", "mcc": "5812",
    "originalSourceTxnId": null, "refundedAmount": null, "attributes": { "emi": false } } }

{ "eventType": "BALANCE_SNAPSHOT", "sourceSystem": "CORE", "sourceEventId": "SNAP:SA-1001:2026-10-09",
  "snapshot": { "accountRef": "SA-1001", "asOfDate": "2026-10-09", "closingBalance": 62000.00 } }
```

Result per event: `ACCEPTED`, `DUPLICATE`, `SUSPENDED`, or `REJECTED` with `errors[{ code, message, path }]`. Codes include `INVALID_ENVELOPE`, `INVALID_PAYLOAD`, `UNKNOWN_REFERENCE`, `UNKNOWN_CUSTOMER`, `UNKNOWN_ACCOUNT`, `ORIGINAL_NOT_FOUND`, `FUTURE_TIMESTAMP`, `CONFLICTING_DUPLICATE`, `SOURCE_MISMATCH`.

Re-delivering the same `(sourceSystem, sourceEventId)` is safe: the response is `DUPLICATE` and nothing changes.

## 5. Read models and exports

| Method | Path | Permission |
|---|---|---|
| GET | `/api/dashboard` | `rules:read` |
| GET | `/api/evaluations`, `/api/evaluations/:id` | `rules:read` (filters `ruleCode`, `customerRef`, `outcome`, `trigger`, `period`, `from`, `to`) |
| GET | `/api/evaluations/export.csv` | `export` (audited) |
| GET | `/api/ledger` , `/api/ledger/export.csv` | `rules:read`; export needs `export` (filters `customerRef`, `ruleCode`, `campaign`, `type`, `from`, `to`) |
| GET | `/api/customers`, `/api/customers/:ref` | `customers:read` (360 view: accounts, progress, ledger, evaluations, nudges) |
| GET | `/api/nudges` | `ops:read` |
| GET / POST | `/api/adjustments`, `/api/adjustments/:id/decide` | request `adjust:request`, decide `adjust:approve` (not the requester) |
| GET | `/api/audit`, `/api/audit/export.csv`, `/api/audit/verify` | `audit:read`; export also needs `export` |

CSV responses use `text/csv`, `Content-Disposition: attachment`, and escape leading `= + - @` to neutralise spreadsheet formula injection.

## 6. Simulation (Testing app)

All need `simulate`; saving cases needs `testcases:write`; `preview` also needs `customers:read`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/sim/rules` | rules and versions available to test |
| POST | `/api/sim/run` | `{ input: { rules[], scenario, expected?, includeActive? }, record? }` → result (below) |
| POST | `/api/sim/matrix` | `{ rule, save?, run?, mode? }` generates the scenario matrix; `save` stores cases, `run` executes them and records a `SIMULATION_RUN` audit entry |
| GET / POST | `/api/sim/cases` | list / save |
| GET / PUT / DELETE | `/api/sim/cases/:id` | includes recent runs |
| POST | `/api/sim/cases/:id/clone` , `/run` | `run` accepts `{ mode: PINNED | LIVE }` |
| POST | `/api/sim/suites/run` | `{ ruleCode?, category?, caseIds?, mode?, label? }` |
| GET | `/api/sim/suites`, `/api/sim/suites/:id`, `…/download` | |
| GET | `/api/sim/runs`, `/api/sim/runs/:id`, `…/download` | download is CSV (`section,name,expected,actual,result`) |
| POST | `/api/sim/perf` | `{ rule, customers≤5000, txnsPerCustomer≤200, duplicateRatio≤0.5 }` |
| POST | `/api/sim/preview` | replay one real customer's history against a rule in the sandbox: `{ rule, customerRef, fromDate?, toDate? }` |
| POST | `/api/sim/preview-sample` | run a rule on a sample of real customers |

### Scenario and result (abridged)

```json
{ "input": {
    "rules": [ { "ruleCode": "CARD_SPEND_10K" } ],
    "scenario": {
      "timezone": "Asia/Kolkata", "asOf": "2026-10-10",
      "customer": { "status": "ACTIVE", "kycStatus": "FULL", "segments": [] },
      "accounts": [ { "ref": "CC-1", "productCode": "CC_GOLD" } ],
      "steps": [
        { "kind": "TXN", "id": "t1", "at": "2026-10-02", "type": "PURCHASE", "channel": "CARD_ONLINE", "amount": 12000, "accountRef": "CC-1" },
        { "kind": "REFUND", "id": "r1", "at": "2026-10-05", "original": "t1", "amount": 3000 } ] },
    "expected": { "totalPoints": 0, "noDuplicateAwards": true } } }
```

Step kinds: `TXN` (with `repeat`, `resendAs` for duplicates and `receivedAt` for late arrival), `STATUS`, `REVERSAL`, `REFUND`, `BALANCE` (with `toDate` for a flat range), `CLOSE`.

The result (`SimResult`) contains `ok`, `passed` (null when there were no expectations), `checks[{ name, expected, actual, pass }]`, `rules` (versions actually tested, flagged `draft` for unsaved definitions), `steps[]` (per step: ingest outcomes, `evaluations` with condition traces, `ledger`, `nudges`, `progressBefore`, `progressAfter`), `final` (`totalPoints`, `pointsByRule`, `awards`, `reversals`, `duplicateAwards`, `ledger`, `progress`, `nudges`, `achievedTier`, event counts), `error`, `durationMs` and `log`. A saved run record adds `status`: `PASSED`, `FAILED` or `ERROR`.

## 7. Conventions worth knowing

* **Idempotency:** safe retries for `ingest`, `events/:id/replay`, `ops/close-periods`, `ops/rules/:code/backfill`. Creating things (`POST /rules`, `/campaigns`, `/admin/*`) returns `409 DUPLICATE*` on repeat.
* **Versioning:** the API is unversioned in Phase 1; breaking changes would go under `/api/v2`.
* **OpenAPI:** the zod schemas in `apps/server/src/routes` are the source of truth; generate OpenAPI with `zod-to-openapi` when a published contract is required.
