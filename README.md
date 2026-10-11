# Money XP (MXP)

A transaction-based gamification, rewards and nudge platform. Business teams configure goals as data (spend, frequency, bill payments, balances, growth, combinations); MXP evaluates them against a central transaction master as events arrive, posts XP to an **immutable ledger** exactly once, and nudges customers towards the next goal.

MXP never posts to or alters financial transactions.

* **Admin Console** (`/`): dashboard, rule builder, campaigns, maker-checker lifecycle, versions and diff, evaluations with full traces, ledger, customers, ingestion, reconciliation, audit, administration.
* **Testing & Simulation app** (`/testing/`): playground, auto-generated scenario matrix, real-customer preview, saved cases, regression suites, performance runs, all in an isolated sandbox that runs the same engine code as production.
* **API** (`/api`): ingestion, rules, simulation, reports. See [docs/05](docs/05-api-contracts.md).

## Quick start

Requires **Node ≥ 22.13**.

```bash
npm install
npm run seed -- --force     # demo users, rules, campaigns, five customers and a month of transactions
npm run build               # builds both web apps
npm run start               # http://127.0.0.1:4000  (API + web + worker)
```

For development with hot reload: `npm run dev` (API on 4000, Vite on 5173).

Sign in at http://127.0.0.1:4000 (demo password **`Mxp@Demo1`**, dev only):

| User | Role | Try |
|---|---|---|
| `maker` | Rule maker | Create a rule, run the matrix, submit |
| `checker` | Rule approver | Approve what `maker` submitted (the maker cannot) |
| `ops` | Operations | Activate, replay events, reconcile, request adjustments |
| `qa` | QA engineer | Testing app: matrix, cases, suites, performance |
| `auditor` | Auditor | Audit log, verify the chain, exports |
| `admin` | System admin | Users, API keys, configuration |

The seeded `UPI_MERCHANT_PER_TXN` rule is left pending approval so the queue is not empty.

## Tests

```bash
npm test                # 304 tests: unit, integration, regression, end to end (~8 s)
npm run typecheck
```

See [docs/09](docs/09-testing-strategy.md).

## Repository layout

```text
packages/engine/    @mxp/engine   schema.sql, ingestion, rules, aggregation, ledger, nudges, reconciliation, simulator
apps/server/        @mxp/server   Fastify API, auth/RBAC, worker, seed / load CLIs
apps/web/           @mxp/web      React: admin console (src/admin) and testing app (src/testing)
samples/            executable sample rules, campaigns, customers and 244 events
scripts/            developer helpers (smoke, perf, matrix, export-samples)
docs/               the ten deliverables
data/               local SQLite files (gitignored)
```

## Documentation (the ten deliverables)

| # | Document |
|---|---|
| 1 | [Business requirements and functional specification](docs/01-requirements.md) |
| 2 | [Architecture and data flow](docs/02-architecture.md) |
| 3 | [ER diagram and schema](docs/03-data-model.md) |
| 4 | [Rule schema and evaluation logic](docs/04-rules-and-evaluation.md) |
| 5 | [API contracts](docs/05-api-contracts.md) |
| 6 | [Admin Console UI and workflows](docs/06-admin-console.md) |
| 7 | [Testing and Simulation app](docs/07-testing-app.md) |
| 8 | [Sample dataset and executable sample rules](docs/08-sample-data.md) |
| 9 | [Automated tests](docs/09-testing-strategy.md) |
| 10 | [Deployment, security, monitoring and runbooks](docs/10-deployment-security-runbooks.md) |

## Design in one paragraph

Events from source systems are validated, normalised and de-duplicated into a **transaction master**. Each transaction is evaluated once against the live rule versions that could apply to it, updating an incrementally maintained **goal progress** row (backed by an append-only journal), so cost per transaction does not depend on history and nothing re-scans the transaction table. Rewards are computed per **slot** as "target versus net in the ledger", so re-processing, replays, duplicates and out-of-order delivery converge to the same ledger; reversals and refunds claw back according to each rule's policy. Rules are versioned, sealed by hash, and go live only through maker-checker approval.

## Status and limits

Phase 1 MVP, fully working end to end. Before production see the limitations in [docs/10 §8](docs/10-deployment-security-runbooks.md): SQLite single writer (move to PostgreSQL for HA), local login with a browser-stored token (integrate your IdP and cookies), encryption at rest delegated to the platform, synchronous simulations (run them on a separate instance), no incremental schema migrations yet, and a logging-only nudge adapter.
# mxp-platform
