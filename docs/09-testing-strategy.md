# 09 – Automated tests: unit, integration, regression and end to end

```bash
npm test                    # everything (304 tests, ~8 s)
npm run test:unit           # packages/engine/test/unit
npm run test:integration    # packages/engine/test/integration
npm run test:regression     # packages/engine/test/regression
npm run test:e2e            # apps/server/test (through the HTTP API)
npm run typecheck           # engine, server and web
```

Tests run on in-memory databases with a **fixed clock** (`2026-10-10T09:00:00Z`) so they are deterministic and fast; no network, no browser.

## 1. Layers

| Layer | Files | Tests | What it proves |
|---|---|---|---|
| **Unit** | `unit/conditions`, `unit/time`, `unit/security` | 34 | Condition operators and null semantics, money in minor units, nested AND / OR / NOT, time-zone and period boundaries (month ends, leap February, quarters, weeks), canonical JSON and hashing, money conversion, password hashing and the role / permission table |
| **Integration** | `integration/scenarios`, `policies`, `ingestion`, `lifecycle`, `engine-flow`, `simulation` | 113 | Each use case end to end through the engine (`scenarios`); tier modes, caps, budgets, frequency, conflict groups, balance gap policy and order independence (`policies`); ingestion rules; rule lifecycle, maker-checker and immutability triggers (`lifecycle`); the golden dataset, late data, adjustments and reconciliation (`engine-flow`); the simulator and its isolation (`simulation`) |
| **Regression** | `regression/matrix`, `regression/golden` | 95 | The auto-generated scenario matrix for every sample rule (84 cases plus structure checks) must stay green; the seeded dataset produces exactly the documented ledger |
| **End to end** | `apps/server/test/*.e2e.test.ts` | 62 | The same journeys over HTTP with real auth and RBAC, including the acceptance scenario |

Total: **304 tests in 15 files.**

## 2. Coverage by requirement

| Requirement | Where it is tested |
|---|---|
| Boundary: ₹9,999 vs ₹10,000, exactly at threshold, greater-than operator | `scenarios`, `policies`, `matrix` (BOUNDARY), `engine-flow` (CUST-1002) |
| Count threshold 9 vs 10, self-transfer and minimum-amount exclusions | `scenarios`, `engine-flow` |
| Average balance, late spike, ₹49,999 vs ₹50,000; balance growth ₹24,999 vs ₹25,000 | `scenarios` |
| Missing balance days → `DATA_UNAVAILABLE`; carry-forward gap policy | `policies`, `matrix` (DATA) |
| Combined goals, withdrawn when a component is reversed | `scenarios`, `matrix` (COMBINED) |
| Tiers: cumulative, highest-only with upgrade | `scenarios`, `policies` |
| Duplicate event, same transaction under new event id, conflicting duplicate | `ingestion`, `scenarios`, `policies`, `matrix` (DUPLICATE), `admin-journey.e2e` |
| Reversal, refund, partial refund, clawback, re-earn after clawback, grandfather | `scenarios`, `matrix` (REVERSAL, REFUND), `admin-journey.e2e` |
| Pending / failed statuses, forward-only transitions, refund parked until original arrives | `scenarios`, `ingestion`, `matrix` (STATUS) |
| Late data after period close; effective-date windows | `engine-flow`, `matrix` (PERIOD) |
| Time zones, month and week and quarter edges, leap year | `time`, `scenarios`, `matrix` |
| Per-period cap, lifetime cap, campaign budget, frequency once, max occurrences | `policies`, `scenarios` (per-event cap) |
| Priority and exclusive conflict groups (highest points, priority) | `policies` |
| Several rules side by side | `scenarios` |
| Idempotency: replay of every transaction, repeated period close, backfill twice, any delivery order | `engine-flow`, `lifecycle`, `policies`, `ops-sim.e2e` |
| Suspend, retry with back-off, dead letter, replay, batch control totals | `ingestion`, `ops-sim.e2e` |
| Rule lifecycle, maker-checker, one open version, rollback, pause-resume-then-backfill, tamper detection of sealed definitions | `lifecycle`, `admin-journey.e2e` |
| Immutability triggers (ledger, journal, audit, master) and audit hash chain | `lifecycle`, `security`, `samples.e2e` |
| Reconciliation detects injected breaks (projection drift, journal mismatch, dead letters, audit tampering, source extract) | `engine-flow`, `ops-sim.e2e` |
| Adjustments: reason, different approver, never negative | `engine-flow`, `security.e2e` |
| Simulation isolation; preview parity with production awards; matrix generation; performance sanity | `simulation`, `matrix`, `ops-sim.e2e` |
| Golden dataset (3,700 awarded, −300 reversed, 3,400 net) reproducible | `engine-flow`, `golden`, `samples.e2e` |
| Authentication, lock-out, rate limit, disabled users | `security.e2e` |
| RBAC matrix (19 role / endpoint pairs) | `security.e2e` |
| API keys: shown once, hashed, source-bound, revocable | `security.e2e` |
| Security headers, error shape without internals, SQL metacharacters as data | `security.e2e` |
| CSV export audited and formula-injection safe | `security.e2e` |
| Production configuration rules and bootstrap | `security.e2e` |
| **Acceptance scenario** (create → simulate → approve → activate → reward, no duplicates) | `admin-journey.e2e` |

## 3. Techniques worth noting

* **Convergence:** different delivery orders, a replayed history and a re-run backfill must give the same ledger business content as the original (`policies`, `golden`, `engine-flow`). Ledger idempotency keys contain a random per-database id, so comparisons use business content (customer, rule, period, slot, points).
* **Generated matrices:** `generateMatrix` derives cases from the rule, so the same test machinery covers any new rule; the regression suite runs it for all sample rules.
* **Oracle by hand:** the golden dataset's expected values are written out in the test, calculated by hand from the sample story, not captured from the engine.
* **Mutation by tampering:** tests edit rows directly (bypassing the app) to prove that triggers, hashes and reconciliation notice.

## 4. What is not automated

* Browser UI: verified manually in a real browser during development (login, dashboard, rule builder, matrix run, Testing app routes). No Playwright suite yet; add one before the first production release.
* Load beyond a single process and SQLite: `scripts/perf.ts` and the Performance page give indicative figures only.
* Penetration testing and dependency scanning: run in CI (`npm audit`, SAST) and by a security team.

## 5. Suggested CI pipeline

```text
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev
# nightly: npx tsx scripts/perf.ts, and the full regression in the Testing app against staging
```

Fail the pipeline on any test or type error; publish the `apps/web/dist` build as an artifact.
