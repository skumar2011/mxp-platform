# 3. Data model (schema v4 — account-centric)

Source of truth: [`packages/platform/src/schema.sql`](../packages/platform/src/schema.sql).  
**ERD (diagrams):** [erd.md](erd.md).

v4 keeps the flat v3 rule model and shifts **runtime and points to the account**. Transactions are loaded from the bank DWH (daily), and rules may target **geography**, **product scope** (CASA / credit card), and an **effective date range**.

## 3.1 Principles

1. **Templates are package files**, not tables (`packages/rules/catalog/templates/`).
2. **One row per bank rule** (`rule`). Status: `DRAFT` → `ACTIVE` ⇄ `PAUSED` → `RETIRED`.
3. **Two families**
   - `MISSION` — customer selects / enrolls; bank sets targets.
   - `SPEND_CONTROL` — customer setting based: customer sets values (within bank bounds) and earns points for compliance.
4. **Transactions belong to accounts** (`account_id` required). `customer_id` is denormalized.
5. **Points accumulate per account** (`points_ledger` / `points_account`). Customer total = sum of accounts.
6. **Rule targeting**: segments, **states** (geo), **productScope** (`ANY` | `CASA` | `CREDIT_CARD`), **effective.from / effective.to**.
7. **DWH daily load** via `dwh_batch` + `POST /api/ops/dwh/sync`.
8. **Performance nudges** (`nudge.kind = PERFORMANCE`) based on overall monthly points, not a single rule.

## 3.2 Tables (~24)

### Reference
| Table | Purpose |
|---|---|
| `segment` | MASS, AFFLUENT, YOUTH, SENIOR |
| `reference_value` | Channels, categories, txn types, **states**, … |
| `merchant` | Merchant directory |

### Customers
| Table | Purpose |
|---|---|
| `customer` | Customer + `state_code` (home state for geo rules) |
| `account` | CASA / credit card / RD / FD products |

### Rules
| Table | Purpose |
|---|---|
| `rule` | Definition JSON + columns `product_scope`, `effective_from`, `effective_to` |

### Participation
| Table | Purpose |
|---|---|
| `customer_setting` | Spend-control values (+ pending) |
| `mission_enrollment` | Opt-in missions |

### Runtime / DWH
| Table | Purpose |
|---|---|
| `dwh_batch` | Daily warehouse load metadata |
| `transaction` | Event store (account-required; optional `dwh_batch_id`) |
| `rule_state` | Engine state (`w\|` `r\|` `l\|` `x\|`) |
| `control_decision` | Pre-auth check log |
| `rule_evaluation` | Outcomes (append-only); limit breaches = `outcome = 'BREACH'` |
| `points_ledger` | Immutable journal **per account** |
| `points_account` | Balance **per account** |
| `nudge` | Rule + performance messages |

### Governance
| Table | Purpose |
|---|---|
| `test_scenario` / `test_run` | Testing app |
| `app_user` / `user_role` | Console login |
| `audit_log` | Hash-chained log |
| `schema_migration` | Version **5** |

## 3.3 Path of one DWH day

```text
DWH extract (business_date)
  → POST /api/ops/dwh/sync
  → dwh_batch + upsert transaction(account_id, …)
  → evaluate (rules in effective date range, matching geo + product scope)
  → points_ledger / points_account (account)
  → generatePerformanceNudges (optional)
```

## 3.4 Fresh database

v4 is not migrated in place from v3:

```bash
npm run seed -- --force
```
