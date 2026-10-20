# 6. Apps

One Vite build produces two React apps served by the API server:

- **Admin console** at `/`: define and govern both rule families, operate customers, audit.
- **Testing app** at `/testing/`: test any rule (live, draft, or from a file) with the same `@mxp/rules` engine the server uses.

Both apps share sign-in, layout and components (`apps/web/src/shared`). Menus and buttons follow the signed-in user's permissions (see [05-api.md](05-api.md#51-roles-and-permissions)); the server enforces them again.

## 6.1 Demo users

Password for all: **`Mxp@Demo1`**. They are created by the seed (`npm run seed`, or `MXP_SEED=1` on an empty database).

| User | Role | What to try |
|---|---|---|
| `maker` | RULE_MAKER | Create a rule from the catalogue, edit the draft, submit. |
| `checker` | RULE_APPROVER | Approve or reject what `maker` submitted (cannot approve own work), activate. |
| `qa` | QA_ENGINEER | Testing app: simulator, scenarios, matrix, rule file lab; set controls on test customers. |
| `ops` | OPERATIONS | Activate, pause, resume, retire; customers, events, close windows, point adjustments. |
| `auditor` | AUDITOR | Audit trail and chain verification; read-only elsewhere. |
| `admin` | SYSTEM_ADMIN | Everything except approval. |

## 6.2 Admin console

| Page | Purpose |
|---|---|
| **Dashboard** | Live spend controls and missions, customer controls set, points awarded, events, limit breaches and pre-auth decisions, pending approvals; charts of points by earned date (30 days), closed windows by outcome, top rules by points. |
| **Rule catalogue** | The templates, grouped into *Bank-defined missions*, *Spend controls* and *Extensions*. Each card shows who sets what. Import a template JSON (`templates:write`). |
| **Template detail** | How the template works in plain language, the parameter table (set by BANK or CUSTOMER, bounds, defaults), the rules built on it, JSON download. "Create rule" starts the editor. |
| **Bank rules** | All rules with family, segments, live version, status, open draft. Filters by family and status. |
| **Rule editor** | 1 · Identity (code, name, segments, featured); 2 · Bank values (BANK parameters such as target, points, channels, action); 3 · Customer choice, spend controls only (min, max, step and default for each CUSTOMER parameter); then Who gets it (segments, eligibility conditions, automatic or opt-in enrolment) and Policy and schedule (effective dates, when a customer's change applies, cooldown). Right-hand panels: **Live check** (validation against the template and the pack, with the plain-language summary) and **Rule file** (the JSON being saved). |
| **Rule detail** | Versions with status, bank values and customer choices per version, workflow history, actions (Submit, Approve, Reject, Activate, Pause, Resume, Retire, New version), the rule file, "Test in the testing app". For spend controls, **What customers chose**: distribution of customer values against the bank's bounds. |
| **By segment** | Personalisation view: per segment (MASS, AFFLUENT, YOUTH, SENIOR) the missions and controls offered, the bounds and defaults, and which is featured. This is where MASS ₹3,000 vs AFFLUENT ₹2,00,000 daily limits and the featured UPI vs RD streaks show side by side. |
| **Rule packs** | Release history (version, fingerprint, rules, publisher, reason); view or download any release. Validate a pack file in the testing app's Rule file lab. |
| **Customers** | Search and filter; create test customers. |
| **Customer detail** | Profile and balance; *Missions*: progress per window, enrol, opt out; *Spend controls*: set or change the customer's value (within bounds, with the effective date shown), switch off, setting history; send an event and see the result and effects; ledger, evaluations, breaches, nudges, events. |
| **Activity** | Tabs for evaluations, ledger, breaches, pre-auth decisions, nudges, events and windows, with filters and CSV export. |
| **Audit trail** | Append-only, hash-chained log of rule changes, approvals, releases, customer settings and sign-ins; chain verification and CSV export. |

## 6.3 Testing app

The pack selector in the header decides which rules every page uses:

- **Live release**: the current pack.
- **Live + drafts**: live rules plus open drafts, pending and approved versions (`/packs/preview?source=OPEN`), so a rule can be tested before approval.
- **File**: a pack loaded in the Rule file lab, never sent to the server.

All evaluation happens in the browser against an in-memory state store, so testing never touches production state. Only saved scenarios and run records are stored.

| Page | Purpose |
|---|---|
| **Simulator** | Pick a persona (MASS, AFFLUENT, YOUTH, SENIOR customers) or edit the profile. Set spend control values and opt in to missions. Send events: quick buttons build a qualifying, non-matching or out-of-scope event for the chosen rule, or use the full event builder. **Check** gives the pre-auth decision without changing state; **Process** applies the event. Change the date and **Close windows** to settle compliance days and missed goals. The timeline shows every step with decision, outcomes, points and the condition trace; *Window state* shows progress per rule. **Save journey as a regression scenario** records the steps and their current results as expectations. Opening `/testing/?rule=CODE` prepares a matching persona, setting and qualifying event. |
| **Scenarios** | Saved regression scenarios: run one or all against the selected pack, see which steps failed and why, accept current results when a change is intended, edit the JSON, import and export, and recent runs. |
| **Boundary matrix** | For each rule, cases generated from its own values: at, just below and just above the target or limit, out of scope, not eligible, not enrolled, refund, daily caps, streak breaks. Shows pass/fail per case; save any rule's cases as a scenario. |
| **Rule file lab** | Paste or upload a template, rule or whole pack. It validates as you type (schema, facts, operators, parameter bounds), shows the parameter table and summary. **Simulate** or **Run matrix** loads it as the *File* source and opens that page; a single rule is wrapped into the current pack, a template gets a sample rule. Load the current pack, or any current rule or template, as a starting point. |

## 6.4 Typical journeys

**Bank-defined mission.** `maker` opens the catalogue → *UPI Transaction Count* → Create rule, sets target 10 and points 150 for MASS → saves and opens it in the testing app (*Live + drafts*). Simulator: 10 qualifying UPI payments → `GOAL_MET`, 150 points. Saves the journey as a scenario, submits. `checker` approves, `ops` activates; a new pack release is published and the server uses it immediately.

**Spend control.** `maker` creates *Daily Spend Limit – Mass*: action ALERT, warn at 80 %, 10 points per compliant day, customer limit between ₹500 and ₹25,000 (default ₹3,000). After activation, the customer (or `ops` from Customer detail) sets ₹2,000. A ₹1,700 spend returns `WARNING`; another ₹500 returns `BREACH` (ALERT). Close windows: the breach day is `BREACHED`; days within the limit are `COMPLIANT` and earn 10 points.
