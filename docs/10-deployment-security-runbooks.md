# 10 – Deployment, security, monitoring and runbooks

> **Status.** Phase 1 is a working, tested MVP. This page describes how to run it safely and where the known production gaps are (section 8). Items marked **Required for production** are not optional.

## 1. Deployment

### 1.1 Requirements

Node.js **≥ 22.13** (uses the built-in `node:sqlite`), npm. One writable directory for the databases. A TLS-terminating reverse proxy in front.

### 1.2 Build and run

```bash
npm ci
npm run build                      # builds apps/web/dist (Admin Console + Testing app)
MXP_ENV=prod \
MXP_JWT_SECRET="$(openssl rand -base64 48)" \
MXP_BOOTSTRAP_ADMIN_PASSWORD='<≥12 chars>' \
MXP_DB=/var/lib/mxp/mxp.db MXP_SIM_DB=/var/lib/mxp/mxp-sim.db \
HOST=0.0.0.0 PORT=4000 \
npm run start                      # API + static web + worker
```

The server serves the built web apps itself (`/` and `/testing/`); put it behind nginx / an ALB for TLS. `npm run start` runs TypeScript through `tsx`; for a hardened image precompile with `tsc` or bundle, and run `node dist/main.js`.

On the first start with an empty database and no `MXP_SEED`, a **bootstrap** creates the reference data and a single `SYSTEM_ADMIN` named `admin` with `MXP_BOOTSTRAP_ADMIN_PASSWORD`. Sign in, change the password, create real users, then **remove the variable**. Rules, campaigns and users are created through the console under maker-checker; customers via the import endpoint or your own loader; `npm run seed` refuses to run in `prod`.

### 1.3 Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MXP_ENV` | `dev` | `dev`, `test`, `staging`, `prod`. `staging` and `prod` require a strong secret; `prod` adds HSTS and trusts the proxy |
| `PORT`, `HOST` | `4000`, `127.0.0.1` | Listen address |
| `MXP_DB` | `data/mxp.db` | Main database |
| `MXP_SIM_DB` | `data/mxp-sim.db` | Simulation store (cases, runs, suites) |
| `MXP_JWT_SECRET` | random in dev | **Required** (≥24 chars) in staging and prod; rotating it signs everyone out |
| `MXP_JWT_TTL` | `8h` | Token lifetime |
| `MXP_WORKER` | on | `0` disables background timers on this instance |
| `MXP_WORKER_INTERVAL_MS` | `1000` | Queue polling interval |
| `MXP_WEB_DIST` | `apps/web/dist` | Static assets |
| `MXP_CORS_ORIGIN` | none | Set only when the console is served from another origin |
| `MXP_SEED` | `1` in dev, else `0` | Load demo data into an empty database |
| `MXP_RATE_LIMIT` | `600` | Requests per minute per client (login: 10, ingest: 3,000) |
| `MXP_BOOTSTRAP_ADMIN_PASSWORD` | – | First-run admin password; remove afterwards |

Engine settings that change at run time without a restart (`PUT /api/admin/config`, audited): `maxAttempts`, `retryBaseSeconds`, `futureToleranceMinutes`, approved nudge channels, default channel, daily progress cap, `storeTrace`.

### 1.4 Topology

```text
                     TLS, WAF, IP allow-list for the console
Browsers ───────────────► reverse proxy ──────────────► mxp-api  (MXP_WORKER=1, exactly one)  ──► database
Source systems (API key) ─►        │                                                                ▲
                                   └───────────────────────► mxp-sim  (MXP_WORKER=0)  ─── read-only role
```

* **Exactly one** process runs the worker timers (SQLite is a single-writer database). Additional API processes use `MXP_WORKER=0`.
* Put **simulation** traffic (`/api/sim/*`) on its own instance, because runs are synchronous and CPU-bound.
* Staging mirrors production with synthetic data; never copy production data into staging without masking.

## 2. Security

### 2.1 Controls in place

| Area | Control |
|---|---|
| Authentication | Username + password, scrypt hashing with per-user salt and stored parameters; JWT (HS256) with expiry; **lock-out** after 5 failures for 15 minutes; identical response for unknown user and wrong password; login rate-limited; disabled users cannot sign in |
| Password policy | ≥ 10 characters with upper case, lower case and a digit; change requires the current password |
| Authorisation | Server-side RBAC on every endpoint (`need(req, permission)`), six roles, **maker-checker by identity** (creator / submitter cannot approve; requester cannot decide an adjustment); unknown permissions denied |
| Source systems | Per-source **API keys**, shown once, stored as a hash, bound to one `sourceSystem`, usable only on `/api/ingest`, revocable; wrong-source events rejected |
| Input validation | zod schemas on every body and query; ingest validates schema, reference data and ownership (an account must belong to the customer); parameterised SQL only; request size limit 4 MB; max 1,000 events per call |
| Output safety | Uniform error shape without stack traces or SQL; `Cache-Control: no-store`; CSV exports escape `= + - @` |
| Browser hardening | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a restrictive CSP (`default-src 'self'`, `frame-ancestors 'none'`), HSTS in prod; React escapes output |
| Integrity | Triggers make the ledger, contribution journal, audit log and the master's financial fields immutable; hash-chained audit log with a verification endpoint; sealed rule-definition hashes verified on load |
| Audit | Logins and failures, user and key management, every rule and campaign state change, adjustments, configuration, exports, simulation evidence; each with actor, roles, before / after, reason, correlation id |
| Data minimisation | Tokenised customer and account references, masked names, no PAN / Aadhaar / raw account numbers; payloads should be tokenised **at the source** |
| Secrets in logs | `authorization` and `x-api-key` headers are redacted from request logs |
| Separation | Environment flag shown in the UI; no demo data or credentials in prod; the simulator cannot write to production tables |
| MXP does not move money | There is no code path that writes to source systems; the master stores copies, and reward points are a separate ledger |

### 2.2 Encryption

* **In transit:** terminate TLS 1.2+ at the proxy; HSTS is sent in prod. Use mTLS or an IP allow-list between source systems and `/api/ingest` where possible.
* **At rest:** the SQLite file is **not** encrypted by the application. **Required for production:** encrypted volumes (LUKS, EBS / disk encryption) and encrypted backups, or move to a managed Postgres with TDE / storage encryption and KMS-managed keys. Field-level encryption is unnecessary because only tokens and masked values are stored.
* **Secrets:** `MXP_JWT_SECRET` and bootstrap values come from a secret manager, not from files in the repository.

### 2.3 Data masking and privacy

* Customer names are stored masked (`A*** S****`); the UI never shows more.
* CSV exports are role-restricted (`export`) and audited. Review the exported columns with your data-protection officer before enabling them in production.
* Nudges require consent (`nudge_consent`) and use only approved channels; suppressed nudges record why.
* Retention and erasure: customer references are tokens, so erasure is performed by the source system's token vault; keep the ledger (financial record) and the audit trail. See retention in [03](03-data-model.md).

## 3. Monitoring and alerting

### 3.1 Endpoints

| Endpoint | Use |
|---|---|
| `GET /api/health` | Liveness (load balancer, process manager) |
| `GET /api/ready` | Readiness: database reachable |
| `GET /api/ops/health` (auth) | `queueDepth`, `suspended`, `deadLetters`, `oldestPending`, `txnAwaitingEvaluation`, `nudgesPending`, `workerEnabled`; the latest reconciliation is at `GET /api/ops/reconciliation` |
| `GET /api/dashboard` | Business view: awards, reversals, active rules, approvals pending |
| `POST /api/ops/reconcile` | Run all internal reconciliation checks on demand |

Logs are structured JSON (Fastify / pino) with a request id; `warn` level in dev and `info` in prod; ship them to your log platform.

### 3.2 Suggested alerts

| Signal | Source | Alert when | First action |
|---|---|---|---|
| API down / not ready | `/api/ready` | 2 consecutive failures | Section 4.1 |
| Pipeline stuck | `/api/ops/health` | `oldestPending` older than 5 min, or `txnAwaitingEvaluation` not falling | Check the worker; run `POST /api/ops/process` |
| Dead letters | `/api/ops/health` | `deadLetters` > 0 | Section 4.3 |
| Rejection rate | ingestion page | spike versus the last 24 h | Source mapping change? Check error codes |
| Reconciliation failed | daily run | any break | Section 4.5 |
| Audit chain broken | `/api/audit/verify` | `ok: false` | Treat as a security incident |
| Login failures | audit `LOGIN_FAILED` | burst from one client | Possible credential stuffing |
| Event latency | `ingestion_event.received_at` vs `processed_at` | p95 > 10 s | Capacity |
| Disk / WAL size | host | > 70 % | Section 4.7 |
| Budget burn | campaign page | > 80 % of `points_budget` | Inform campaign owner |

Schedule `POST /api/ops/reconcile` at least daily (a small cron with an `OPERATIONS` service account) and alert on a failed status.

## 4. Runbooks

### 4.1 Service will not start or is not ready

1. Read the log. `MXP_JWT_SECRET is required…` → set a ≥24-char secret. `no users` warning → provide `MXP_BOOTSTRAP_ADMIN_PASSWORD`.
2. `database is locked` → another process holds the file; there must be only one writer. Stop the stray process.
3. Corrupt or missing database → section 4.8.

### 4.2 Events are not being processed (pipeline stuck)

1. `GET /api/ops/health`: is `queueDepth` growing, is `oldestPending` old, is `workerEnabled` true?
2. Is the worker on? Exactly one instance must have `MXP_WORKER` on. Check the log for `worker failed`.
3. Drain manually: `POST /api/ops/process`. If events fail, open one in *Ingestion* and read its error and history.
4. Restart the worker instance; the event table is the queue, so nothing is lost and processing is idempotent.

### 4.3 Dead-lettered or rejected events

1. *Ingestion → Dead letters / Rejected*; open the event: error code, verbatim payload, stage history.
2. Common causes: `UNKNOWN_CUSTOMER` / `UNKNOWN_ACCOUNT` (master data not loaded yet: import the customers), `UNKNOWN_REFERENCE` (new channel or category: add reference data via a change), `ORIGINAL_NOT_FOUND` (a refund before its original), `FUTURE_TIMESTAMP` (source clock skew), `SOURCE_MISMATCH` (wrong API key).
3. Fix the cause. For dead-lettered events press **Replay** (or `POST /api/events/:id/replay`). Rejected events are fixed at the source and re-sent under the same event id.
4. Replay is idempotent. If a business user disputes a missing reward, find the transaction in *Evaluations* and read its trace.

### 4.4 Activating, pausing, rolling back a rule

* **Go live:** validate → run the matrix → submit → approve (a different person) → activate. Choose **backfill** only if customers who already qualified this period should be rewarded now. After activation, watch *Evaluations* and the dashboard for the first hour.
* **Pause** (`reason` required): the rule stops evaluating immediately; existing rewards stand. **Resume** does **not** catch up on what was missed: afterwards run **Backfill** on the rule (`POST /api/ops/rules/:code/backfill`), which is idempotent.
* **Rollback:** *History → Roll back* (or `POST /api/rules/:code/rollback` with `versionNo` and `reason`) re-activates a superseded version. Rewards already issued by the later version are **not** withdrawn automatically. If they were wrong, raise **adjustments** (section 4.6) with the evidence.
* **Retire:** the rule stops for good; history remains.
* **Emergency stop:** pause the rule (or the campaign) first, then investigate.

### 4.5 Reconciliation break

1. *Reconciliation → Run*; open each break: type, entity, expected, actual.
2. By type: `LEDGER_BALANCE` (XP account differs from the ledger sum) → the ledger is authoritative. There is no automated projection rebuild in Phase 1: have a reviewed support script recompute `xp_account` from `SUM(xp_ledger.points)` and record it as an audited change. `PROGRESS_VS_JOURNAL` → replay the transaction (`POST /api/ops/rules/:code/backfill`). `JOURNAL_VS_MASTER` / `TXN_NOT_EVALUATED` → process the queue. `REVERSAL_INTEGRITY` → investigate immediately (a reversal exceeds its award). `BATCH_CONTROL` → ask the source to resend or confirm the control total. `PIPELINE_STUCK`, `DEAD_LETTERS` → sections 4.2 and 4.3. `AUDIT_CHAIN` → incident. `CAMPAIGN_BUDGET` → the budget was exceeded; review with the campaign owner.
3. **Source reconciliation:** upload the source system's control extract (`POST /api/ops/reconcile-source`) to find transactions that are missing, extra or different in amount or status.
4. Re-run until clean and record the reason for any accepted exception.

### 4.6 Correcting a customer's XP

Never edit the ledger (triggers prevent it). Use *Ledger → Request adjustment* (Operations): customer, points (positive or negative), reason. A **different** approver approves; the ledger gets an `ADJUSTMENT` row linked to the request; the balance cannot go negative.

### 4.7 Backups, restore and disaster recovery

* **Backup (SQLite):** `VACUUM INTO '/backups/mxp-<date>.db'` takes a consistent snapshot while the service runs (for example `sqlite3 /var/lib/mxp/mxp.db "VACUUM INTO '/backups/mxp-$(date +%F).db'"`). Back up the simulation store the same way (low value). Encrypt and copy off-host. Target **RPO ≤ 15 minutes** using frequent snapshots or WAL shipping (Litestream), or managed Postgres point-in-time recovery.
* **Restore:** stop the service; put the snapshot at `MXP_DB`; start; then **verify**: `GET /api/audit/verify` (`ok: true`), `POST /api/ops/reconcile` (PASSED), spot-check a customer 360. Because ingestion is idempotent, ask sources to **re-send events since the snapshot time**; duplicates are ignored and gaps fill.
* **Disaster recovery:** restore the latest snapshot in the standby region with the same secrets; repoint the proxy; re-send from sources. Test this at least twice a year and record the time it took (RTO).
* **Rebuilding projections:** `goal_progress` and `xp_account` are derivable from the journal and ledger; reconciliation shows when they drift.
* **WAL growth:** a long-running reader keeps `-wal` large; checkpoint during quiet hours (`PRAGMA wal_checkpoint(TRUNCATE)`), and keep at least 3× the database size free.

### 4.8 Users, keys and secrets

* **Joiner / mover / leaver:** create users with the least role needed (*Administration → Users*), review roles quarterly, disable leavers the same day (disable, do not delete: the audit trail refers to them).
* **Locked account:** *Users → Unlock* (`PATCH /api/admin/users/:username {"unlock": true}`).
* **API key rotation:** create a second key for the source, switch the source over, revoke the old key. Keys are shown once; a lost key is replaced, not recovered.
* **JWT secret rotation:** change `MXP_JWT_SECRET` and restart; everyone signs in again.
* **Suspected compromise:** disable the user, revoke keys, rotate the secret, run *Audit → Verify*, export and review the audit log around the incident.

### 4.9 Period close and month-end

* Periods close automatically (every 15 minutes, once the period plus grace has passed in the rule's time zone). To force it: `POST /api/ops/close-periods` (idempotent).
* Check the dashboard on the first working day: closed periods show `CLOSED_ACHIEVED` / `CLOSED_NOT_ACHIEVED`. Balance goals show `DATA_UNAVAILABLE` if snapshots are missing: obtain the missing snapshots from the core system and re-send them **before** closing if possible; after closing, an authorised adjustment is the only way to reward (late data cannot earn).

### 4.10 Releasing a new MXP version

1. CI: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
2. Take a backup. Deploy to staging; run the full regression suite from the Testing app and `POST /api/ops/reconcile`.
3. Deploy to production in a quiet window (stop the worker instance last, start it first on the new version); the database records its schema version in `schema_migration` (currently 1). **Phase 1 has no incremental migration scripts**: any future schema change needs a numbered, reviewed migration added to `migrate()` and tested on a restored copy of production first. Keep the previous build for rollback.
4. Smoke test: `/api/ready`, sign in, ingest one test event from a sandbox source, dashboard, reconcile.
5. If the release must be reverted: redeploy the previous build; restore the backup if a migration ran.

## 5. Capacity

Indicative single-process figures from `scripts/perf.ts` on a developer laptop: **2,700–3,900 events/s**, per-event engine latency p99 below 1 ms, with zero duplicate awards. Treat them as a lower bound for SQLite on SSD and a starting point for sizing. To scale beyond one writer: move to PostgreSQL, run several workers using `FOR UPDATE SKIP LOCKED`, partition by month ([03](03-data-model.md) §6), and keep the simulator on separate instances.

## 6. Operational calendar

| When | Task |
|---|---|
| Continuous | Alerts in section 3.2 |
| Daily | Reconciliation run reviewed; dead letters empty |
| Weekly | Backup restore test in staging; review approvals queue age |
| Monthly | Period close check; budget burn; access review |
| Quarterly | DR test, dependency update (`npm audit`), rotate secrets |

## 7. Compliance mapping (summary)

| Expectation | Where satisfied |
|---|---|
| Segregation of duties | Maker-checker, role model |
| Complete audit trail, tamper-evident | Hash-chained audit, immutability triggers, sealed rules |
| Access control and least privilege | RBAC, lock-out, API-key scoping |
| Change control | Versioned rules, approval, activation record, rollback |
| Data protection | Tokenisation, masking, consent, audited export |
| Reconciliation | Daily internal and optional source reconciliation |
| Resilience | Retry, DLQ, replay, backups, DR runbook |

## 8. Known limitations and production gaps (be explicit)

1. **Database:** SQLite is single-writer. Fine for the MVP and moderate volume; move to PostgreSQL for HA and horizontal workers. There is no built-in replication; HA means a warm standby restored from snapshots or Litestream.
2. **Identity:** local users with a JWT stored in browser `localStorage` (key `mxp.token`). That is simple but exposed to XSS if one is ever introduced. **Required for production:** integrate the bank's IdP (OIDC / SAML) with MFA and move to httpOnly, same-site cookies.
3. **Encryption at rest** is delegated to the platform (section 2.2).
4. **Synchronous simulations** (single, matrix, performance) block the event loop of the process they run in. Run them on a dedicated instance.
5. **Read-only enforcement** for the simulator's access to production rules is by code (`SELECT`s only), not by a read-only database connection. Use a read-only database role for the sim instance in production.
6. **Demo credentials** are displayed on the login screen in `dev` only.
7. **Nudge delivery** uses a logging adapter; plug in the real push / SMS gateway behind `NudgeAdapter`.
8. **Customer master** is imported via API or loader; a continuous sync from the CIF is an integration task.
9. **No browser automation suite** yet; the UI was verified manually.
10. **Metrics** are via health endpoints and logs; add Prometheus / OpenTelemetry exporters for dashboards.
