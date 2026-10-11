# 08 – Sample dataset and executable sample rules

Everything below is runnable and tested.

## 1. What ships

| Path | Content |
|---|---|
| `samples/rules/*.json` | The six use-case rules plus one per-event rule, each as the body of `POST /api/rules` |
| `samples/campaigns.json` | `MXP_ALWAYS_ON` (2026–2027) and `UTILITY_FEST` (Sep 1 – Nov 30, 2026, 100,000 XP budget) |
| `samples/customers.json` | Five customers, accounts and instruments (masked names) for `POST /api/admin/customers/import` |
| `samples/events.json` | 244 events (balance snapshots and transactions) with the `arrivedAt` time at which each reached MXP |
| `scripts/export-samples.ts` | Regenerates the files above from the seed code for the reference date **2026-10-10** |
| `apps/server/src/loadSamples.ts`, `loadCli.ts` | Loader that uses the public API only, in maker-checker order |

The same data is what `npm run seed` loads into the demo database (relative to today's date).

## 2. Loading

```bash
# 1. a running server with reference data and users; for the demo seed this is already done
npm run seed -- --force          # demo users, rules, campaigns, customers, one month of data
npm run start

# 2. or, into an empty system (users maker, checker, admin, ops must exist), through the API
npm run load:samples -- http://127.0.0.1:4000
#   MXP_LOAD_USERS=maker:checker:admin:ops  MXP_LOAD_PASSWORD=...  to use other accounts
```

The loader: imports customers → creates and activates both campaigns → for each rule creates, submits (maker), approves (checker), activates (admin) → delivers events in arrival order, closing periods and dispatching nudges after each day. `UPI_MERCHANT_PER_TXN` is left **pending approval** on purpose so the approval queue is not empty.

> The sample events are dated September–October 2026. They earn rewards only when the server clock is inside that window (earlier periods are closed and late data cannot earn, by design). The automated test replays them under a controlled clock; for a demo on any date use `npm run seed`, which generates the same story relative to today.

## 3. Demo accounts (dev only, password `Mxp@Demo1`)

| User | Role |
|---|---|
| `maker` | `RULE_MAKER` |
| `checker` | `RULE_APPROVER` |
| `qa` | `QA_ENGINEER` |
| `ops` | `OPERATIONS` |
| `auditor` | `AUDITOR` |
| `admin` | `SYSTEM_ADMIN` |

## 4. The story in the data

| Customer | What they do | Expected result |
|---|---|---|
| **CUST-1001** (affluent) | Card spend ₹4,200 + ₹5,100 + ₹3,100 = ₹12,400; 12 UPI merchant payments; 3 utility bills; savings balance ≈ ₹62–66k all of last month | `CARD_SPEND_10K` **300**; `UPI_10_TXNS` **100**; `UTILITY_3_BILLS` **150**; `SAV_AVG_BAL_50K` (September) **500** |
| **CUST-1002** (salaried) | Card spend **₹9,999** (₹6,999 + ₹3,000); 9 UPI payments + 1 self-transfer; average savings ≈ ₹48.5k | Everything **just misses**: **0 XP**; progress and near-target nudges sent |
| **CUST-1003** (digital-first) | Savings balance rises from ₹31k to ₹61k during last month; 3 utility bills across the campaign (1 last month, 2 this month) | `SAV_GROWTH_25K` **400**; `UTILITY_3_BILLS` **150** |
| **CUST-1004** (affluent) | Savings flat ₹55k; card spend ₹10,500 last month; this month ₹8,000 + ₹3,000 + ₹1,500 then a **₹3,000 refund** | `BALANCE_PLUS_CARD` **1,000**; `SAV_AVG_BAL_50K` **500**; card September **300**; card October **300 awarded then −300 clawed back** |
| **CUST-1005** (new, no nudge consent) | 6 small UPI payments; balance ₹8,000 | **0 XP**; nudges **suppressed** (`NO_CONSENT`) |

### Totals after loading

| | XP |
|---|---|
| Awarded | **3,700** |
| Reversed | **−300** |
| **Net in the ledger** | **3,400** |
| Ingestion events processed | 244 (0 rejected) |
| Duplicate awards | 0 |
| Reconciliation | PASSED |
| Audit chain | valid |

These numbers are asserted by `apps/server/test/samples.e2e.test.ts` (through the API) and `packages/engine/test/regression/golden.test.ts` (through the seed).

## 5. Rule files, at a glance

| File | Kind | Metric / period | Tiers | Key conditions |
|---|---|---|---|---|
| `SAV_AVG_BAL_50K` | GOAL | `AVG_BALANCE`, monthly | ₹50,000 → 500 | active, KYC full; savings accounts, active |
| `CARD_SPEND_10K` | GOAL, cumulative | `SUM`, monthly | ₹10,000 → 300; ₹25,000 → 400 | purchases, debit, credit card; **not** category RENT; reversal `CLAWBACK` |
| `UPI_10_TXNS` | GOAL | `COUNT`, monthly | 10 → 100 | UPI debits ≥ ₹10, not `SELF_TRANSFER` |
| `UTILITY_3_BILLS` | GOAL | `COUNT`, **campaign** period | 3 → 150; 6 → 250 | `BILL_PAYMENT` + `UTILITY_BILL`, recurring |
| `SAV_GROWTH_25K` | GOAL | `BALANCE_GROWTH`, monthly | +₹25,000 → 400 | savings accounts, active |
| `BALANCE_PLUS_CARD` | COMBINED | components met, monthly | both (2) → 1,000 | components `SAV_AVG_BAL_50K` and `CARD_SPEND_10K`, tier ≥ 1 |
| `UPI_MERCHANT_PER_TXN` | PER_EVENT | 1 XP per ₹100, cap 200 XP / month | – | merchant payment, debit; **pending approval** |

## 6. Try it yourself

1. Sign in as `maker`; open *Rules → New rule* and paste `samples/rules/CARD_SPEND_10K.json`'s `definition` into the JSON tab; change the threshold to ₹5,000 and the code to `CARD_SPEND_5K`.
2. Open *Testing app → Scenario matrix*, select the draft, **Generate and run**. Fix anything red.
3. Back in the console: **Submit**. Sign in as `checker`: review the plain-English summary, the diff and the evidence; **Approve**.
4. Sign in as `ops` or `admin`: **Activate** (choose whether to backfill).
5. Open *Customers → CUST-1001* and check the new goal progress and any award; deliver the same event twice from *Ingestion* and confirm the ledger is unchanged.
