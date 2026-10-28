# MXP v5 — Entity relationship diagram

Source: [`packages/platform/src/schema.sql`](../packages/platform/src/schema.sql). Narrative: [03-data-model.md](03-data-model.md).

## Overview (areas)

```mermaid
flowchart LR
  subgraph REF["1. Reference"]
    segment
    reference_value
    merchant
  end
  subgraph CUST["2. Customers"]
    customer
    account
  end
  subgraph RULES["3. Rules"]
    rule
  end
  subgraph PART["4. Participation"]
    customer_setting
    mission_enrollment
  end
  subgraph RUN["5. Runtime"]
    txn["transaction"]
    rule_state
    control_decision
    rule_evaluation
    points_ledger
    points_account
    nudge
  end
  subgraph GOV["6. Governance"]
    test_scenario
    test_run
    app_user
    user_role
    audit_log
  end

  segment --> customer
  customer --> account
  customer --> customer_setting
  customer --> mission_enrollment
  rule --> customer_setting
  rule --> mission_enrollment
  customer --> txn
  txn --> rule_evaluation
  txn --> points_ledger
  customer --> rule_state
  customer --> nudge
  app_user --> user_role
  test_scenario --> test_run
```

## Full ERD (keys and relationships)

> Notes for GitHub Mermaid: the SQL table `"transaction"` is drawn as `txn` (reserved word). Composite keys use a single marker (`PK` only) — GitHub’s Mermaid build rejects `PK,FK`.

```mermaid
erDiagram
  segment ||--o{ customer : has
  customer ||--o{ account : owns
  customer ||--|| points_account : balance

  customer ||--o{ customer_setting : sets
  rule ||--o{ customer_setting : configures
  customer ||--o{ mission_enrollment : joins
  rule ||--o{ mission_enrollment : offers

  customer ||--o{ txn : posts
  txn ||--o{ rule_evaluation : produces
  txn ||--o{ spend_control_breach : may_breach
  txn ||--o{ points_ledger : may_earn
  rule_evaluation ||--o| spend_control_breach : details

  customer ||--o{ rule_state : progress
  customer ||--o{ control_decision : preauth
  customer ||--o{ points_ledger : ledger
  customer ||--o{ nudge : messages
  customer ||--o{ rule_evaluation : evaluated
  customer ||--o{ spend_control_breach : breaches

  test_scenario ||--o{ test_run : runs
  app_user ||--o{ user_role : has_role

  segment {
    string segment_code PK
    string name
    int sort_order
  }
  customer {
    string customer_id PK
    string customer_ref UK
    string segment_code FK
    string timezone
    string attributes_json
  }
  account {
    string account_id PK
    string customer_id FK
    string account_type
    string product_family
  }
  rule {
    string rule_code PK
    string family
    string template_code
    string status
    string definition_json
  }
  customer_setting {
    string setting_id PK
    string customer_id FK
    string rule_code FK
    string values_json
    string effective_from
    string pending_from
    string status
  }
  mission_enrollment {
    string customer_id PK
    string rule_code PK
    string status
    string enrolled_at
  }
  txn {
    string event_id PK
    string source_system
    string source_event_id
    string event_type
    string customer_id FK
    string occurred_at
    string payload_json
    string status
  }
  rule_state {
    string state_key PK
    string prefix
    string rule_code
    string customer_id
    string window_key
    string state_json
  }
  control_decision {
    string decision_id PK
    string customer_id
    string decision
    string reasons_json
  }
  rule_evaluation {
    string evaluation_id PK
    string event_id
    string rule_code
    string customer_id
    string outcome
    int points
  }
  spend_control_breach {
    string breach_id PK
    string evaluation_id
    string customer_id
    string rule_code
    string event_id
    float limit_value
    float measured_value
  }
  points_ledger {
    int ledger_id PK
    string customer_id FK
    string entry_type
    int points
    string rule_code
    string event_id
    string idempotency_key UK
    string earned_on
  }
  points_account {
    string customer_id PK
    int balance
    int lifetime_earned
  }
  nudge {
    string nudge_id PK
    string customer_id
    string rule_code
    string dedupe_key UK
  }
  test_scenario {
    string scenario_id PK
    string name
    string definition_json
  }
  test_run {
    string run_id PK
    string scenario_id FK
    string run_kind
    int passed
    int failed
  }
  app_user {
    string user_id PK
    string username UK
    string password_hash
  }
  user_role {
    string user_id PK
    string role_code PK
  }
  audit_log {
    int audit_id PK
    string actor
    string action
    string entity_type
    string entity_id
    string row_hash
  }
  reference_value {
    string list_code PK
    string value_code PK
    string label
  }
  merchant {
    string merchant_id PK
    string name
    string category_code
  }
```

## Logical links (no FK in SQLite)

| From | Column | To | Why |
|---|---|---|---|
| `rule` | `template_code` | `@mxp/rules` template file | Templates are not DB rows |
| `rule` | `states` (in JSON) | `reference_value` list `states` | Geo targeting |
| `rule` | `product_scope` | CASA / CREDIT_CARD / ANY | Product-level rules |
| `rule_state` / evaluations / ledger / nudge | `rule_code` | `rule.rule_code` | Soft link so history survives retirement |
| `transaction` | `reversal_of` | `transaction.event_id` | Refunds |
| `nudge` | `kind = PERFORMANCE` | (no rule) | Overall portfolio performance |

## Path of one DWH day

```mermaid
sequenceDiagram
  participant DWH as Data warehouse
  participant API as POST /ops/dwh/sync
  participant TXN as transaction
  participant ENG as @mxp/rules
  participant PL as points_ledger
  participant PA as points_account
  participant N as nudge

  DWH->>API: rows for business_date
  API->>TXN: upsert by account_id
  API->>ENG: process each new/changed event
  Note over ENG: filter by effective dates, states, productScope
  ENG-->>API: evaluations + effects
  API->>PL: AWARD/CLAWBACK per account
  API->>PA: UPDATE account balance
  API->>N: PERFORMANCE nudges optional
```

Open this file in an editor with Mermaid preview (or GitHub) to render the diagrams.
