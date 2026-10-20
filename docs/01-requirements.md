# 1. Requirements

Money XP (MXP) rewards banking customers with points for good money habits. Version 2 splits the rules into two families that differ in **who sets the target**.

| | Bank-defined mission | Spend control |
|---|---|---|
| Who writes the rule | Bank | Bank |
| Who sets the target value | Bank (e.g. "10 UPI payments a month") | **Customer** (e.g. "my daily limit is ₹2,000"), inside bounds the bank sets |
| What earns points | Reaching the target (or each qualifying item) | Staying within the customer's own limit for a window |
| Real-time effect | None (progress, nudges) | Pre-authorisation decision: ALLOW, WARN, ALERT or BLOCK |
| Customer action needed | None for AUTO missions; opt-in for OPT_IN missions | The customer turns the control on and picks the value |

Reference: [MXP capability overview](https://mxpcapability.netlify.app): six spend controls, six missions, three extensions, "configuration not development", segment personalisation.

## 1.1 Capability coverage

Every capability is a **rule template** (a rule file) in `packages/rules/catalog/templates`. The bank configures **rules** from templates; no code changes are needed to add a rule.

| Capability | Template | Family | Customer sets | Measure / window / reward |
|---|---|---|---|---|
| Daily spend limit | `DAILY_SPEND_LIMIT` | Spend control | `limit` | SUM per DAY, points per compliant day |
| Monthly spend limit | `MONTHLY_SPEND_LIMIT` | Spend control | `limit` | SUM per calendar month or rolling 30 days |
| Merchant category limit | `CATEGORY_SPEND_LIMIT` | Spend control | `categories`, `limit` | SUM per period |
| Merchant restrictions | `MERCHANT_RESTRICTION` | Spend control | `merchants` | COUNT of blocked-merchant spend must stay 0 |
| Transaction type restrictions | `TXN_TYPE_RESTRICTION` | Spend control | `blockedTypes` | COUNT must stay 0 |
| Timing restrictions | `TIMING_RESTRICTION` | Spend control | `from`, `to` | COUNT in the customer's local restricted hours must stay 0 |
| Average balance maintenance | `AVG_BALANCE_DAYS` | Mission | - | DISTINCT_DAYS above a threshold in the month |
| Average monthly balance | `AVG_MONTHLY_BALANCE` | Mission | - | AVG_DAILY with tiers, paid at month end |
| UPI transaction count | `UPI_TXN_COUNT` | Mission | - | COUNT with minimum amount and a per-day cap |
| Refer a customer | `REFER_A_CUSTOMER` | Mission | - | PER_EVENT on approval, deduplicated, clawed back on rejection |
| Avail an additional product | `ADDITIONAL_PRODUCT` | Mission | - | PER_EVENT once per product family |
| RD payment streak | `RD_PAYMENT_STREAK` | Mission | - | STREAK of on-time months with milestones |
| RD timeline completion (extension) | `RD_COMPLETION` | Mission | - | One-off on maturity with few missed installments |
| FD renewal (extension) | `FD_RENEWAL` | Mission | - | Points per ₹ renewed, yearly cap |
| Dormancy prevention (extension) | `DORMANCY_PREVENTION` | Mission | - | Active days for customers flagged at risk |
| Cross-product spend diversity (extension) | `SPEND_DIVERSITY` | Mission | - | COUNT_DISTINCT products, opt-in |

## 1.2 Segment personalisation

Segments are data, not code. The sample configuration reproduces the reference site:

| | MASS | AFFLUENT |
|---|---|---|
| Daily limit (customer default, bounds) | ₹3,000 (₹500 – ₹25,000), rule `DSL_MASS` | ₹2,00,000 (₹10,000 – ₹5,00,000), rule `DSL_AFFLUENT` |
| Category emphasis | Food & Groceries (`CSL_MASS`) | Travel & Dining (`CSL_AFFLUENT`) |
| Featured mission | UPI streak (`UPI_STREAK_MASS`) | RD streak (`RD_STREAK_AFFLUENT`) |

YOUTH and SENIOR segments exist to show that a new segment is a row plus rule targeting.

## 1.3 Deliverables

1. **Rules module (BRE)**: `@mxp/rules`. Any app loads a rule pack file and gets decisions, outcomes and effects. No database or server needed. Spec: [04-rule-files.md](04-rule-files.md).
2. **Table schema**: the system of record for templates, rules, versions, approvals, releases, customer settings, events, state, points and audit. Spec: [03-data-model.md](03-data-model.md); spreadsheet: [mxp-table-relationships.xlsx](mxp-table-relationships.xlsx).
3. **Admin console**: define and govern both families (templates, rules, maker-checker, releases, customers, activity). See [06-apps.md](06-apps.md).
4. **Testing app**: test every rule (simulator, regression scenarios, boundary matrix, rule file lab) against the live release, drafts, or any file. See [06-apps.md](06-apps.md).

## 1.4 Functional rules

- A spend control applies only when the customer has a setting for it. Values outside the bank's bounds are rejected.
- A changed customer value takes effect immediately or from the next window (per rule), with an optional cooldown between changes. Settings are effective-dated, so past events are evaluated against the value in force at the time.
- Compliance rewards need minimum activity in the window, so inactivity is not rewarded.
- A breach stays a breach even if the transaction is later refunded.
- Missions support tiers, caps (per window, per year, lifetime), deduplication keys, per-day caps and clawback on reversal.
- Windows are calendar (day, week, month, quarter, year), rolling, fixed or lifetime, in the pack timezone or the customer's own timezone, with optional grace days for late events.
- Rule changes go through maker-checker: the approver must be a different user from the maker and the submitter. Every live change publishes a new pack release.
- Events are idempotent per (source system, source event id). Re-sending the same event is a no-op; sending different content under the same id is rejected.
- Points live in an immutable ledger; corrections are new rows. Balances are a rebuildable projection.

## 1.5 Assumptions

- Upstream systems send normalised events (transaction, balance snapshot, referral, product application, RD installment/maturity, FD maturity). Field names are listed in the fact model.
- Points redemption, notifications delivery and customer-facing apps are out of scope; MXP produces nudges and ledger entries for them.
- SQLite is used for the demo; the schema maps 1:1 to PostgreSQL (see [03-data-model.md](03-data-model.md)).
