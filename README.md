# Money XP (MXP) v2

MXP rewards customers with points for good money habits. It has two families of rules:

| | Bank-defined missions | Spend controls |
|---|---|---|
| Who sets the rule | Bank | Bank |
| Who sets the value | Bank (target, e.g. "10 UPI payments") | Customer, within bank bounds (e.g. "my daily limit is ₹2,000") |
| Points for | Reaching the target | Staying within the customer's own limit |
| Examples | UPI streak, RD streak, salary credit, minimum balance, referral, FD renewal | Daily / category / merchant limits, timing and transaction type restrictions |

Rules are **configuration, not development**: templates define logic once; the bank configures rules from templates per segment (MASS ₹3,000 vs AFFLUENT ₹2,00,000 daily limit, featured UPI vs RD streak); every live change publishes a **rule pack file** that any app can run with the `@mxp/rules` engine.

- **Admin console** (`/`): define both families from the template catalogue, maker-checker approval, segments, packs, customers, activity, audit.
- **Testing app** (`/testing/`): simulator, regression scenarios, boundary matrix and rule file lab, against live rules, drafts or a pack file.
- **Rules engine** (`packages/rules`): load a pack file, evaluate events, get decisions, outcomes and points. No database or framework needed.
- **Table schema** (`packages/platform/src/schema.sql`, **v3 simplified**): ~22 tables; templates are files in `@mxp/rules`. See [docs/03-data-model.md](docs/03-data-model.md).

## Quick start

Requires **Node ≥ 22.13** (uses the built-in `node:sqlite`).

```bash
npm install
npm run seed -- --force     # 16 templates, 21 live rules, 6 customers across 4 segments, 21 days of activity, 10 test scenarios
npm run build               # builds the admin console and testing app
npm start                   # http://127.0.0.1:4000  (API + both apps + window-close worker)
```

For development with hot reload: `npm run dev` (API on 4000, Vite on http://127.0.0.1:5173).

Sign in with any demo user, password **`Mxp@Demo1`**:

| User | Role |
|---|---|
| `maker` | Creates and edits rules, submits for approval |
| `checker` | Approves or rejects (never their own), activates |
| `qa` | Testing app, test customers |
| `ops` | Activates, pauses, retires; customers, events, window close |
| `auditor` | Audit trail |
| `admin` | Everything except approval |

The seed leaves a `DSL_MASS` v2 waiting for approval and a `UPI_STREAK_SENIOR` draft, so the queue and the "Live + drafts" test source are not empty.

## Use the rules engine in another app

```bash
npm run export:pack                       # current release → examples/mxp-retail.pack.json
npx tsx examples/embed-node.ts            # load the pack, set a customer limit, process events, close the day
```

```ts
import { RulesEngine, MemoryStateStore } from '@mxp/rules';
const engine = RulesEngine.fromPack(JSON.parse(packFile));
const result = engine.process(event, { customer, settings, enrollments }, new MemoryStateStore());
// result.decision, result.evaluations, result.effects (AWARD / CLAWBACK / BREACH / NUDGE), result.points
```

Rule file formats and the engine API: [docs/04-rule-files.md](docs/04-rule-files.md).

## Tests

```bash
npm test             # vitest: rules engine, platform, API
npm run typecheck
```

The testing app adds rule-level checks: the boundary matrix generates cases for every rule, and the seeded regression scenarios run from the Scenarios page.

## Repository layout

```text
packages/rules/      @mxp/rules     BRE: rule file schemas, validation, engine, state store, testing helpers
  catalog/           template JSON files and the sample bank rules
packages/platform/   @mxp/platform  schema.sql, SQLite store, catalogue lifecycle, runtime, queries, audit, seed
apps/server/         @mxp/server    Fastify API, auth and permissions, worker, seed CLI
apps/web/            @mxp/web       admin console (src/admin) and testing app (src/testing)
scripts/             export-pack.ts
examples/            embed-node.ts and an exported pack
docs/                requirements, architecture, data model, rule files, API, apps
```

## Documentation

1. [Requirements](docs/01-requirements.md)
2. [Architecture](docs/02-architecture.md)
3. [Data model](docs/03-data-model.md) and [table relationships workbook](docs/mxp-table-relationships.xlsx)
4. [Rule files and the rules engine](docs/04-rule-files.md)
5. [API](docs/05-api.md)
6. [Apps](docs/06-apps.md)

## Deploy

`render.yaml` deploys one web service (build: `npm install && npm run build`; start: `npm start`) with `MXP_ENV=prod`, a generated `MXP_JWT_SECRET` and demo seeding on an empty database. Configuration: [docs/05-api.md](docs/05-api.md#53-configuration).
