# 4. Rule files and the rules engine (`@mxp/rules`)

`@mxp/rules` is a business rules engine for MXP. An app gives it a **rule pack file** and a **state store**; it returns decisions, outcomes and effects. It has no database, network or framework dependency (only zod), and runs in Node, browsers and edge runtimes. The MXP server, the testing app and [`examples/embed-node.ts`](../examples/embed-node.ts) all use it the same way.

## 4.1 Documents

All rule files are JSON with a `kind`.

| Kind | Written by | Contains |
|---|---|---|
| `RuleTemplate` | Product / engineering, rarely | Logic (events, scope, filter, measure, window, goal, control, reward) with `{"$param": "name"}` placeholders, and the parameter list. Each parameter is `setBy: "BANK"` or `setBy: "CUSTOMER"`. |
| `Rule` | Bank business users (admin console) | A configured instance of a template: values for BANK parameters, bounds for CUSTOMER parameters, segments, eligibility, enrolment, effective dates, change policy. |
| `RulePack` | Published by MXP on every live change | `references` (value lists), `templates`, `rules`, timezone, currency. **This is the file other apps load.** |
| `CustomerSetting` | The customer (spend controls only) | `values` for the CUSTOMER parameters, effective-dated, versioned. Passed to the engine at evaluation time. |

### Template (mission example)

```json
{
  "kind": "RuleTemplate", "code": "UPI_TXN_COUNT", "version": 1, "family": "MISSION",
  "name": "UPI Transaction Count",
  "summary": "Make {target} UPI payments of at least {minAmount} this month (max {maxPerDay} a day count). Earn {points} points.",
  "params": [
    { "name": "target",    "label": "Payments required",            "type": "integer", "setBy": "BANK", "min": 1, "default": 10 },
    { "name": "points",    "label": "Points",                       "type": "integer", "setBy": "BANK", "min": 0, "default": 150 },
    { "name": "minAmount", "label": "Minimum payment amount",       "type": "money",   "setBy": "BANK", "min": 1, "default": 50 },
    { "name": "maxPerDay", "label": "Max payments counted per day", "type": "integer", "setBy": "BANK", "min": 1, "default": 3 }
  ],
  "logic": {
    "events": ["TRANSACTION"],
    "scope":  { "all": [ { "field": "event.channel", "op": "eq", "value": "UPI" },
                         { "field": "event.dr_cr", "op": "eq", "value": "D" },
                         { "field": "event.txn_type", "op": "not_in", "value": ["SELF_TRANSFER", "REFUND"] } ] },
    "filter": { "field": "event.amount", "op": "gte", "value": { "$param": "minAmount" } },
    "measure": { "type": "COUNT", "perDayCap": { "$param": "maxPerDay" } },
    "window":  { "type": "MONTH" },
    "goal":    { "op": "gte", "target": { "$param": "target" } },
    "reward":  { "mode": "ON_GOAL", "points": { "$param": "points" } },
    "nudges":  { "nearGoalPct": 70 }
  }
}
```

### Template (spend control example)

```json
{
  "kind": "RuleTemplate", "code": "DAILY_SPEND_LIMIT", "version": 1, "family": "SPEND_CONTROL",
  "name": "Daily Spend Limit",
  "params": [
    { "name": "limit",    "label": "Daily limit",       "type": "money",  "setBy": "CUSTOMER", "min": 100, "max": 1000000, "step": 100 },
    { "name": "channels", "label": "Channels covered",  "type": "enum[]", "setBy": "BANK", "optionsFrom": "channels", "default": ["CARD_POS", "CARD_ONLINE", "UPI"] },
    { "name": "action",   "label": "When the limit is exceeded", "type": "enum", "setBy": "BANK", "options": ["ALERT", "BLOCK"], "default": "ALERT" },
    { "name": "warnAtPct","label": "Warn at % of limit", "type": "percent", "setBy": "BANK", "default": 80 },
    { "name": "points",   "label": "Points per compliant day", "type": "integer", "setBy": "BANK", "default": 10 },
    { "name": "minActivity", "label": "Minimum transactions in the day to earn", "type": "integer", "setBy": "BANK", "default": 1 }
  ],
  "logic": {
    "events": ["TRANSACTION"],
    "scope": { "all": [ { "field": "event.dr_cr", "op": "eq", "value": "D" },
                        { "field": "event.channel", "op": "in", "value": { "$param": "channels" } },
                        { "field": "event.txn_type", "op": "not_in", "value": ["SELF_TRANSFER", "REFUND"] } ] },
    "measure": { "type": "SUM", "field": "event.amount" },
    "window":  { "type": "DAY" },
    "goal":    { "op": "lte", "target": { "$param": "limit" } },
    "control": { "action": { "$param": "action" }, "warnAtPct": { "$param": "warnAtPct" } },
    "reward":  { "mode": "WINDOW_COMPLIANCE", "points": { "$param": "points" }, "minActivity": { "$param": "minActivity" } }
  }
}
```

### Rule (bank configuration of the spend control above)

```json
{
  "kind": "Rule", "code": "DSL_MASS", "template": "DAILY_SPEND_LIMIT",
  "name": "Daily Spend Limit – Mass", "segments": ["MASS", "YOUTH"],
  "params": { "channels": ["CARD_POS", "CARD_ONLINE", "UPI"], "action": "ALERT", "warnAtPct": 80, "points": 10, "minActivity": 1 },
  "customerParams": { "limit": { "min": 500, "max": 25000, "step": 100, "default": 3000 } },
  "settingsPolicy": { "changeEffective": "NEXT_WINDOW", "cooldownDays": 0 },
  "effective": { "from": "2026-01-01", "to": null },
  "enrollment": "AUTO", "priority": 100, "featured": false, "tags": []
}
```

The AFFLUENT version (`DSL_AFFLUENT`) is the same template with `customerParams.limit = { min: 10000, max: 500000, default: 200000 }` and different points. That is segment personalisation by configuration.

### Customer setting

```json
{ "settingId": "S1", "customerId": "C1001", "ruleCode": "DSL_MASS", "values": { "limit": 2000 }, "effectiveFrom": "2026-10-15", "version": 2 }
```

Pass every version; the engine uses the version effective on each event's local date.

## 4.2 Logic reference

| Field | Values | Meaning |
|---|---|---|
| `events` | `TRANSACTION`, `BALANCE_SNAPSHOT`, `REFERRAL`, `PRODUCT_APPLICATION`, `RD_INSTALLMENT`, `RD_MATURITY`, `FD_MATURITY` (any string the host sends) | Event types the rule listens to. |
| `subject` | `CUSTOMER` (default), `ACCOUNT` | Whose progress is tracked. |
| `scope` | condition | Events considered at all. In-scope events count as activity. |
| `filter` | condition | In-scope events that are measured. For restrictions the filter describes the forbidden spend. |
| `measure.type` | `COUNT`, `SUM`, `COUNT_DISTINCT`, `DISTINCT_DAYS`, `AVG_DAILY`, `STREAK` | How progress is computed. Options: `field`, `perDayCap`, `dedupeBy`, `denominator`, `streakPeriod`, `breakWhen`. |
| `window.type` | `DAY`, `WEEK`, `MONTH`, `QUARTER`, `YEAR`, `ROLLING_DAYS` (+`days`, `period`), `FIXED` (+`from`, `to`), `LIFETIME` | Period progress resets on. `timezone`: IANA zone or `CUSTOMER`. `graceDays` accepts late events. |
| `goal` | `op` (`gte`, `gt`, `lte`, `lt`, `eq`), `target` or `tiers[]` | Mission goal (gte) or spend limit (lte). |
| `control` | `action` (`ALERT`, `BLOCK`), `warnAtPct` | Spend controls only: decision when the limit is crossed, warning threshold. |
| `reward.mode` | `ON_GOAL`, `PER_EVENT`, `WINDOW_COMPLIANCE`, `NONE` | When points are earned. Options: `points`, `perAmount`, `awardAt` (`GOAL_MET` / `WINDOW_CLOSE`), `tierMode`, `capPointsPerWindow`, `capPointsLifetime`, `maxAwardsPerWindow`, `maxAwards`, `minActivity`, `onReversal` (`CLAWBACK` / `KEEP`). |
| `nudges.nearGoalPct` | 1–99 | Progress level that triggers a "nearly there" nudge. |

### Conditions

```json
{ "all": [ ... ] }    { "any": [ ... ] }    { "not": { ... } }
{ "field": "event.amount", "op": "gte", "value": 500 }
{ "field": "event.channel", "op": "in", "value": { "$param": "channels" } }
```

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, `between`, `contains`, `starts_with`, `exists`, `not_exists`, `time_between` (handles ranges across midnight, e.g. 23:00–06:00).

### Facts

| Prefix | Fields |
|---|---|
| `event.` | `amount`, `dr_cr`, `channel`, `txn_type`, `category`, `merchant_id`, `merchant_name`, `mcc`, `product_family`, `payee_id`, `international`, `status`, `balance`, `as_of_date`, `account_type`, `referral_id`, `application_id`, `installment_no`, `on_time`, `installments_missed`, `tenure_months`, `action`, `maturity_id`, `type` |
| `event.local.` | `date`, `time`, `hour`, `dow` (1 = Monday), `dom`: computed in the window timezone (customer timezone when the rule says so) |
| `customer.` | `segment`, `status`, `kyc_status`, `days_since_last_txn`, `products`, `tenure_days`, `dormancy_risk`, plus any host attribute |
| `account.` | `type`, `status` |

A pack can ship its own `facts` list to replace the built-in banking model; the validator checks every condition against it.

### Parameter types

`number`, `money`, `integer`, `percent`, `string`, `enum` (`options` or `optionsFrom` a reference list), `enum[]`, `string[]`, `time` (HH:mm), `boolean`. Bounds: `min`, `max`, `step`; for lists `maxItems`.

## 4.3 Evaluation semantics

For each event the engine selects rules listening to the event type, sorted by priority, then for each rule:

1. **Effective dates**: outside → `NOT_EFFECTIVE`.
2. **Eligibility**: segment list and eligibility condition → `NOT_ELIGIBLE`.
3. **Participation**: OPT_IN missions need an enrolment (`NOT_ENROLLED`); spend controls need a customer setting effective on the event date (otherwise skipped); invalid values → `INVALID_SETTING`.
4. **Scope** → `OUT_OF_SCOPE`; **filter** → `NOT_MATCHED` (still counts as activity).
5. **Measure** inside the window (per-day caps, dedupe keys, duplicates → `DUPLICATE`, closed window → `WINDOW_CLOSED`).
6. **Outcome**: missions → `PROGRESS`, `GOAL_MET`, `AWARDED`, `CAPPED`, `STREAK_BROKEN`; spend controls → `WITHIN_LIMIT`, `WARNING`, `BREACH`; reversals → `REVERSED` (with clawback where configured).

`close(asOf)` settles windows: `COMPLIANT` (points if `minActivity` met), `BREACHED`, `NO_ACTIVITY`, `GOAL_MET` (paid at close), `MISSED`.

Every evaluation carries the rule version, window key, measure before/after, target, points, a plain-language message and a condition trace (which leaf passed or failed, with actual values).

### Results

```ts
interface ProcessResult {
  decision: 'ALLOW' | 'WARN' | 'ALERT' | 'BLOCK'; // strictest across spend controls
  evaluations: Evaluation[];                      // one per rule considered
  effects: Effect[];                              // what the host must persist or act on
  points: number;                                 // net points in this call
}
type Effect =
  | { type: 'AWARD' | 'CLAWBACK'; points; slot; idempotencyKey; reason; ruleCode; windowKey; eventId? }
  | { type: 'BREACH'; settingId; limit; value; action: 'ALERT' | 'BLOCK'; ... }
  | { type: 'NUDGE'; kind; message; dedupeKey; ... };
```

Hosts persist points by `idempotencyKey` and nudges by `dedupeKey`; replaying an event never pays twice.

## 4.4 Embedding API

```ts
import { RulesEngine, MemoryStateStore } from '@mxp/rules';

const engine = RulesEngine.fromPack(packJson);          // validates; throws RulePackError with issues
const store = new MemoryStateStore();                   // or your own StateStore

engine.availableFor(ctx, date);                         // controls and missions offered to this customer
engine.customerParams('DSL_MASS');                      // what the customer sets, with the bank's bounds applied
engine.validateSetting('DSL_MASS', { limit: 2000 });    // [] or issues
engine.planSettingChange(code, values, { now, lastChangedAt }); // effective date and cooldown check
engine.describe('DSL_MASS', { limit: 2000 });           // plain-language summary

engine.check(event, ctx, store);                        // pre-auth decision, nothing changed
engine.process(event, ctx, store);                      // apply the event
engine.close('2026-10-15', store, (customerId) => ctx); // settle finished windows
```

`ctx` is `{ customer, account, settings, enrollments }` (see `EvalContext`). `RulesEngine.fromPack(pack, { skipInvalidRules: true })` drops invalid rules instead of rejecting the pack (used by preview tools).

### Validation and testing helpers

| Function | Use |
|---|---|
| `validatePack(json)` | Schema and semantic checks for a whole pack (unknown facts, operators against field types, unresolved parameters, bounds outside the template's limits, duplicate codes, timezone). |
| `parseTemplate`, `checkTemplate`, `parseRule`, `checkRule` | Check one document. |
| `describeRule(rule, template, values?)` | Plain-language summary for UIs. |
| `runScenario(engine, scenario)` | Replay a journey (settings, events, checks, closes) and compare outcomes, decisions and points with expectations. |
| `generateBoundaryCases(engine, code)` | Derive at / below / above target, out of scope, not eligible, not enrolled, refund, cap and streak cases from a rule's own values. |
| `caseBuilder(engine, code, values)` | Build qualifying, non-matching and out-of-scope events for a rule. |
| `fingerprint(json)` | Stable hash of a document (canonical JSON). |

## 4.5 Versioning and compatibility

- Templates and rules carry `version`. A rule may pin `templateVersion`; the validator rejects a mismatch.
- The platform refuses a template version that would invalidate live or pending rules (`BREAKS_LIVE_RULES`).
- Packs are self-contained: references, facts (optional) and every template a rule uses are inside, so a pack file is enough to reproduce any decision.
