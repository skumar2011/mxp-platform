# 5. API (`apps/server`)

Fastify 5 server. Every route is under `/api`. The built web apps are served from the same origin (`/` admin console, `/testing/` testing app).

- **Auth**: `POST /api/auth/login` returns a JWT; send it as `Authorization: Bearer <token>`. Only `/api/health`, `/api/ready` and `/api/auth/login` are public.
- **Errors**: `{ "error": { "code", "message", "details?" } }`. 422 for validation (`VALIDATION`, `INVALID_PACK`, `INVALID_RULE`, `INVALID_SETTING`, `BREAKS_LIVE_RULES`, …), 409 for state conflicts (`EVENT_CONFLICT`, `BAD_STATE`, `OPEN_VERSION`, …), 403 for missing permission or `MAKER_CHECKER`, 429 when rate-limited.
- **Lists** take `limit` and `offset`; report lists also take `?format=csv`.

## 5.1 Roles and permissions

| Permission | RULE_MAKER | RULE_APPROVER | QA_ENGINEER | OPERATIONS | AUDITOR | SYSTEM_ADMIN |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `rules:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `rules:write`, `templates:write` | ✓ | | | | | ✓ |
| `rules:approve` | | ✓ | | | | |
| `rules:activate` | | ✓ | | ✓ | | ✓ |
| `customers:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `customers:write`, `events:write`, `ops:run` | | | ✓ | ✓ | | ✓ |
| `tests:write` | ✓ | | ✓ | | | ✓ |
| `audit:read` | | ✓ | | | ✓ | ✓ |
| `users:admin` | | | | | | ✓ |

Only RULE_APPROVER can approve, and never a version they authored (maker-checker is enforced in `@mxp/platform`, not just the UI).

## 5.2 Routes

### Auth and system

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/health` | public | Liveness. |
| GET | `/ready` | public | Database reachable; returns the current release label. |
| POST | `/auth/login` | public | `{ username, password }` → `{ token, user: { username, name, roles, permissions } }`. 10/min. |
| GET | `/auth/me` | signed in | |
| POST | `/auth/logout` | signed in | Audited; the client discards the token (tokens expire after `MXP_JWT_TTL`). |
| POST | `/auth/password` | signed in | `{ current, password }`. |
| GET | `/users` | `users:admin` | |

### Templates, rules and packs

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/meta` | `rules:read` | Reference lists, facts, operators, measures, windows, outcomes for editors. |
| GET | `/templates` · `/templates/:code` | `rules:read` | |
| GET | `/templates/:code/file` | `rules:read` | Template JSON download. |
| POST | `/templates` | `templates:write` | `{ template, note? }`: new template or new version; refused if it breaks live or pending rules. |
| GET | `/rules` · `/rules/:code` | `rules:read` | `/rules/:code` includes every version, workflow history and the live version. |
| GET | `/rules/:code/versions/:v/file` | `rules:read` | Rule JSON download. |
| POST | `/rules/validate` | `rules:read` | `{ rule }` → issues and summary, nothing saved. |
| POST | `/rules` | `rules:write` | `{ rule, note? }`: creates a draft (new rule or next version). |
| PUT | `/rules/:code/versions/:v` | `rules:write` | Edit a draft. |
| POST | `/rules/:code/versions/:v/submit` | `rules:write` | DRAFT → PENDING_APPROVAL. |
| POST | `/rules/:code/versions/:v/approve` | `rules:approve` | `{ note? }` → APPROVED. |
| POST | `/rules/:code/versions/:v/reject` | `rules:approve` | `{ reason }` (required) → REJECTED, from pending or approved. |
| POST | `/rules/:code/versions/:v/activate` | `rules:activate` | APPROVED → ACTIVE; publishes a new pack release. |
| POST | `/rules/:code/pause` · `/resume` · `/retire` | `rules:activate` | `{ reason? }`; publishes a new pack release. |
| GET | `/packs` | `rules:read` | Release history. |
| GET | `/packs/current` | `rules:read` | The pack the runtime is using. |
| GET | `/packs/:id` | `rules:read` | `?download=1` returns `mxp-retail-<version>.pack.json`. |
| GET | `/packs/preview?source=CURRENT\|OPEN` | `rules:read` | OPEN = live rules plus open drafts / pending / approved versions (used by the testing app). |
| POST | `/packs/validate` | `rules:read` | `{ pack }` → `{ ok, issues, rules, templates }`. |
| GET | `/segments/overview` | `rules:read` | Rules per segment with the customer bounds and featured flags. |

### Customers and participation

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/customers` | `customers:read` | Filters `q`, `segment`. |
| POST | `/customers` · PATCH `/customers/:id` | `customers:write` | Test customers and attributes. |
| GET | `/customers/:id` | `customers:read` | Profile, balance, settings, enrolments, windows, ledger, evaluations, breaches, nudges, events. |
| GET | `/customers/:id/offers` | `customers:read` | Controls and missions available to this customer, with bounds and current values. |
| PUT | `/customers/:id/controls/:rule` | `customers:write` | `{ values, reason?, via? }`: set a spend control value; returns the effective date. |
| DELETE | `/customers/:id/controls/:rule` | `customers:write` | Switch a control off; the setting ends today. `?reason=`. |
| POST | `/customers/:id/missions/:rule/enroll` · `/opt-out` | `customers:write` | OPT_IN missions. |
| POST | `/customers/:id/points/adjust` | `ops:run` | `{ points, reason }`: manual ledger entry. |

### Events and operations

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/events` | `events:write` | One event (below) → `{ eventId, duplicate, status, decision, points, evaluations, effects }`. |
| POST | `/events/batch` | `events:write` | `{ events: [...] }` up to 1000. |
| POST | `/controls/check` | `events:write` | Pre-authorisation: same event shape plus `requestId`; returns `{ decisionId, decision, reasons, evaluations, latencyMs }`. No state change apart from the decision log. |
| POST | `/ops/close-windows` | `ops:run` | `{ asOf? }`: settle windows that ended before `asOf` (default today). |
| GET | `/ops/reconcile` | `ops:run` | Ledger vs balance mismatches and audit chain check. |

Event body:

```json
{
  "sourceSystem": "CBS", "sourceEventId": "TXN-88231",
  "type": "TRANSACTION", "customerId": "C1001", "accountId": "A1001",
  "timestamp": "2026-10-14T13:05:00+05:30",
  "amount": 1250, "dr_cr": "D", "channel": "UPI", "txn_type": "PURCHASE",
  "category": "FOOD_GROCERY", "merchant_id": "M_BIGBASKET", "merchant_name": "BigBasket"
}
```

Any extra field is kept and available to rules as `event.<field>`. `(sourceSystem, sourceEventId)` is the idempotency key: the same key with the same content returns `duplicate: true`; with different content returns 409. A reversal sends `reversalOf` with the original event id.

### Reports

| Method | Path | Permission | Filters | CSV |
|---|---|---|---|---|
| GET | `/dashboard` | `rules:read` | | |
| GET | `/evaluations` | `customers:read` | `customerId`, `ruleCode`, `outcome`, `family`, `eventId` | ✓ |
| GET | `/ledger` | `customers:read` | `customerId`, `ruleCode`, `entryType` | ✓ |
| GET | `/breaches` | `customers:read` | `customerId`, `ruleCode` | ✓ |
| GET | `/decisions` | `customers:read` | `customerId`, `decision` | |
| GET | `/nudges` | `customers:read` | `customerId`, `kind` | |
| GET | `/events` | `customers:read` | `customerId`, `type`, `status` | |
| GET | `/windows` | `customers:read` | `customerId`, `ruleCode`, `status`, `family` | ✓ |
| GET | `/windows/detail?key=` | `customers:read` | | |
| GET | `/audit` | `audit:read` | `entityType`, `entityId`, `actor` | ✓ |
| GET | `/audit/verify` | `audit:read` | | |

### Testing

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/test-scenarios` · `/test-scenarios/:id` | `rules:read` | |
| POST | `/test-scenarios` | `tests:write` | `{ scenario }`: create, or update when `scenario.id` exists. |
| DELETE | `/test-scenarios/:id` | `tests:write` | |
| GET | `/test-runs` | `rules:read` | |
| POST | `/test-runs` | `tests:write` | `{ kind, packSource, packHash, results }`. |

## 5.3 Configuration

| Variable | Default | |
|---|---|---|
| `MXP_ENV` | `dev` | `dev`, `test`, `staging`, `prod`. |
| `PORT` / `HOST` | 4000 / 127.0.0.1 | Binds 0.0.0.0 when `PORT` is set or in staging/prod. |
| `MXP_DB` | `data/mxp.db` | SQLite file. |
| `MXP_JWT_SECRET` | random per start in dev | Required (24+ characters) in staging and prod. |
| `MXP_JWT_TTL` | `8h` | |
| `MXP_WORKER` / `MXP_WORKER_INTERVAL_MS` | on / 60000 | In-process window-close worker. |
| `MXP_WEB_DIST` | `apps/web/dist` | Built web apps to serve. |
| `MXP_CORS_ORIGIN` | none | |
| `MXP_SEED` | `1` in dev | Seed an empty database on start. |
| `MXP_RATE_LIMIT` | 600 / minute | |
