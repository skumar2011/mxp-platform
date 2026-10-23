/**
 * Rule file format. Three document kinds make up a rule pack:
 *
 *   RuleTemplate  the logic of a rule type, written once, with named parameters.
 *                 Each parameter declares who sets it: BANK or CUSTOMER.
 *   Rule          a bank configuration of a template: values for BANK parameters,
 *                 bounds for CUSTOMER parameters, targeting and reward.
 *   RulePack      the distributable file: templates + rules + fact model.
 *
 * Bank-defined missions have only BANK parameters. Spend controls have at least
 * one CUSTOMER parameter (the limit, the blocked merchants...) whose value comes
 * from a CustomerSetting at evaluation time.
 */
import { z } from 'zod';

export const FAMILIES = ['MISSION', 'SPEND_CONTROL'] as const;
export type Family = (typeof FAMILIES)[number];

export const PARAM_TYPES = ['number', 'money', 'integer', 'percent', 'string', 'enum', 'enum[]', 'string[]', 'time', 'boolean'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export const OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'contains', 'starts_with', 'exists', 'not_exists', 'time_between'] as const;
export type Operator = (typeof OPERATORS)[number];

export const MEASURES = ['COUNT', 'SUM', 'COUNT_DISTINCT', 'DISTINCT_DAYS', 'AVG_DAILY', 'STREAK'] as const;
export type MeasureType = (typeof MEASURES)[number];

export const WINDOWS = ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR', 'ROLLING_DAYS', 'FIXED', 'LIFETIME'] as const;
export type WindowType = (typeof WINDOWS)[number];
export const CALENDAR_WINDOWS = ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'] as const;

export const GOAL_OPS = ['gte', 'gt', 'lte', 'lt', 'eq'] as const;
export type GoalOp = (typeof GOAL_OPS)[number];

export const REWARD_MODES = ['ON_GOAL', 'PER_EVENT', 'WINDOW_COMPLIANCE', 'NONE'] as const;
export type RewardMode = (typeof REWARD_MODES)[number];

export const CONTROL_ACTIONS = ['ALERT', 'BLOCK'] as const;

const ident = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'Use letters, digits and _ (start with a letter)');
const code = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/, 'Use UPPER_SNAKE_CASE, 3-64 characters');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** A value that is either literal or a reference to a parameter: { "$param": "limit" }. */
export const paramRef = z.object({ $param: ident }).strict();
export type ParamRef = z.infer<typeof paramRef>;
const val = <T extends z.ZodTypeAny>(t: T) => z.union([paramRef, t]);
export type Val<T> = T | ParamRef;

// ---------- conditions ----------
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { field: string; op: Operator; value?: unknown };

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionSchema) }).strict(),
    z.object({ any: z.array(conditionSchema) }).strict(),
    z.object({ not: conditionSchema }).strict(),
    z.object({ field: z.string().min(1).max(120), op: z.enum(OPERATORS), value: z.unknown().optional() }).strict(),
  ]),
);

// ---------- template parameters ----------
export const paramDefSchema = z
  .object({
    name: ident,
    label: z.string().min(1).max(80),
    type: z.enum(PARAM_TYPES),
    setBy: z.enum(['BANK', 'CUSTOMER']),
    required: z.boolean().default(true),
    default: z.unknown().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    options: z.array(z.string()).optional(),
    /** Name of a reference list in the pack (channels, categories, ...). */
    optionsFrom: z.string().optional(),
    unit: z.string().max(20).optional(),
    description: z.string().max(400).optional(),
  })
  .strict();
export type ParamDef = z.infer<typeof paramDefSchema>;

// ---------- logic ----------
export const measureSchema = z
  .object({
    type: z.enum(MEASURES),
    /** Numeric field for SUM / AVG_DAILY, key field for COUNT_DISTINCT. */
    field: z.string().optional(),
    /** At most this much is counted per day (count or amount). Anti-gaming. */
    perDayCap: val(z.number().positive()).optional(),
    /** Events with the same value of this field replace each other (corrections, re-sent approvals). */
    dedupeBy: z.string().optional(),
    /** AVG_DAILY denominator: days with data, or every day of the window. */
    denominator: z.enum(['OBSERVED_DAYS', 'WINDOW_DAYS']).optional(),
    /** STREAK: the period that must contain a qualifying event to keep the streak alive. */
    streakPeriod: z.enum(CALENDAR_WINDOWS).optional(),
    /** STREAK: an in-scope event matching this resets the streak. */
    breakWhen: conditionSchema.optional(),
  })
  .strict();
export type Measure = z.infer<typeof measureSchema>;

export const windowSchema = z
  .object({
    type: val(z.enum(WINDOWS)),
    /** ROLLING_DAYS length. */
    days: val(z.number().int().min(1).max(366)).optional(),
    /** ROLLING_DAYS: calendar period used to track compliance and rewards. */
    period: z.enum(CALENDAR_WINDOWS).optional(),
    from: val(isoDate).optional(),
    to: val(isoDate).optional(),
    /** IANA zone, or CUSTOMER to use customer.timezone (falls back to the pack timezone). */
    timezone: z.string().optional(),
    /** Days after the window ends during which late events are still accepted. */
    graceDays: z.number().int().min(0).max(31).default(0),
  })
  .strict();
export type Window = z.infer<typeof windowSchema>;

export const tierSchema = z.object({ target: val(z.number()), points: val(z.number().int().min(0)), label: z.string().max(60).optional() }).strict();
export type Tier = z.infer<typeof tierSchema>;

export const goalSchema = z
  .object({
    op: z.enum(GOAL_OPS),
    target: val(z.number()).optional(),
    /** Milestones (missions). Each tier awards its points once per window. */
    tiers: z.array(tierSchema).optional(),
  })
  .strict();
export type Goal = z.infer<typeof goalSchema>;

export const controlSchema = z
  .object({
    action: val(z.enum(CONTROL_ACTIONS)),
    /** Warn when the measure reaches this % of the limit. */
    warnAtPct: val(z.number().min(1).max(100)).optional(),
  })
  .strict();

export const rewardSchema = z
  .object({
    mode: z.enum(REWARD_MODES),
    points: val(z.number().int().min(0)).optional(),
    /** PER_EVENT: points for every `perAmount` of the measured field (e.g. 1 point per ₹100). */
    perAmount: val(z.number().positive()).optional(),
    /** ON_GOAL: award as soon as the goal is met, or only when the window closes (averages). */
    awardAt: z.enum(['GOAL_MET', 'WINDOW_CLOSE']).default('GOAL_MET'),
    tierMode: z.enum(['CUMULATIVE', 'HIGHEST_ONLY']).default('CUMULATIVE'),
    capPointsPerWindow: val(z.number().int().min(0)).optional(),
    capPointsLifetime: val(z.number().int().min(0)).optional(),
    maxAwardsPerWindow: val(z.number().int().min(1)).optional(),
    /** Lifetime number of awards (1 = once only). */
    maxAwards: val(z.number().int().min(1)).optional(),
    /** WINDOW_COMPLIANCE: minimum in-scope events in the window to qualify (stops rewarding inactivity). */
    minActivity: val(z.number().int().min(1)).optional(),
    onReversal: z.enum(['CLAWBACK', 'KEEP']).default('CLAWBACK'),
  })
  .strict();
export type Reward = z.infer<typeof rewardSchema>;

export const logicSchema = z
  .object({
    events: z.array(z.string().min(1)).min(1),
    subject: z.enum(['CUSTOMER', 'ACCOUNT']).default('CUSTOMER'),
    /** Which events are considered at all (and count as activity). */
    scope: conditionSchema.optional(),
    /** Which in-scope events are measured. */
    filter: conditionSchema.optional(),
    measure: measureSchema,
    window: windowSchema,
    goal: goalSchema.optional(),
    control: controlSchema.optional(),
    reward: rewardSchema,
    nudges: z.object({ nearGoalPct: z.number().min(1).max(99).default(80) }).strict().default({}),
  })
  .strict();
export type Logic = z.infer<typeof logicSchema>;

export const templateSchema = z
  .object({
    kind: z.literal('RuleTemplate'),
    code,
    version: z.number().int().min(1).default(1),
    family: z.enum(FAMILIES),
    name: z.string().min(3).max(120),
    description: z.string().max(1000).default(''),
    icon: z.string().max(8).optional(),
    category: z.string().max(40).optional(),
    /** Plain-language summary with {param} tokens. */
    summary: z.string().max(300).optional(),
    params: z.array(paramDefSchema).default([]),
    logic: logicSchema,
  })
  .strict();
export type RuleTemplate = z.infer<typeof templateSchema>;
export type RuleTemplateInput = z.input<typeof templateSchema>;

export const customerParamBoundsSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    options: z.array(z.string()).optional(),
    default: z.unknown().optional(),
    /** enum[] / string[]: maximum number of selections. */
    maxItems: z.number().int().min(1).optional(),
  })
  .strict();
export type CustomerParamBounds = z.infer<typeof customerParamBoundsSchema>;

export const ruleSchema = z
  .object({
    kind: z.literal('Rule'),
    code,
    version: z.number().int().min(1).default(1),
    template: code,
    templateVersion: z.number().int().min(1).optional(),
    name: z.string().min(3).max(120),
    description: z.string().max(1000).default(''),
    status: z.enum(['ACTIVE', 'PAUSED', 'DRAFT']).default('ACTIVE'),
    /** Shortcut targeting: customer.segment must be one of these. Empty = all. */
    segments: z.array(z.string()).default([]),
    /** Geographic targeting: customer.state must be one of these. Empty = all states. */
    states: z.array(z.string()).default([]),
    /**
     * Product scope for the rule.
     * ANY = all accounts; CASA = savings/current/debit; CREDIT_CARD = credit cards.
     */
    productScope: z.enum(['ANY', 'CASA', 'CREDIT_CARD']).default('ANY'),
    /** Extra eligibility on the customer / account context. */
    eligibility: conditionSchema.optional(),
    /** Missions: AUTO enrols every eligible customer; OPT_IN needs an enrolment. Spend controls are always opt-in through a setting. */
    enrollment: z.enum(['AUTO', 'OPT_IN']).default('AUTO'),
    /** Values for BANK parameters. */
    params: z.record(z.unknown()).default({}),
    /** Bounds the bank places on CUSTOMER parameters. */
    customerParams: z.record(customerParamBoundsSchema).default({}),
    /** Spend controls: when a changed customer value takes effect, and how often it may change. */
    settingsPolicy: z
      .object({
        changeEffective: z.enum(['IMMEDIATE', 'NEXT_WINDOW']).default('NEXT_WINDOW'),
        cooldownDays: z.number().int().min(0).max(365).default(0),
      })
      .strict()
      .default({}),
    /** Inclusive calendar dates: transactions outside this range are not evaluated. */
    effective: z.object({ from: isoDate.nullable().default(null), to: isoDate.nullable().default(null) }).strict().default({}),
    priority: z.number().int().min(0).max(1000).default(100),
    featured: z.boolean().default(false),
    tags: z.array(z.string().max(40)).default([]),
  })
  .strict();
export type Rule = z.infer<typeof ruleSchema>;
export type RuleInput = z.input<typeof ruleSchema>;

export const FACT_TYPES = ['string', 'enum', 'number', 'money', 'boolean', 'array', 'date', 'time'] as const;
export type FactType = (typeof FACT_TYPES)[number];
export const factSchema = z
  .object({ path: z.string().min(1), label: z.string(), type: z.enum(FACT_TYPES), valuesFrom: z.string().optional(), values: z.array(z.string()).optional(), events: z.array(z.string()).optional() })
  .strict();
export type FactDef = z.infer<typeof factSchema>;

export const packSchema = z
  .object({
    kind: z.literal('RulePack'),
    pack: z.string().min(1).max(80),
    version: z.string().min(1).max(40),
    timezone: z.string().default('Asia/Kolkata'),
    currency: z.string().length(3).default('INR'),
    description: z.string().max(1000).optional(),
    /** Fact model used by the validator and the admin UI. Optional: defaults to the built-in banking model. */
    facts: z.array(factSchema).optional(),
    /** Named value lists (channels, categories, txn_types, segments...). */
    references: z.record(z.array(z.string())).default({}),
    templates: z.array(templateSchema).default([]),
    rules: z.array(ruleSchema).default([]),
    generatedAt: z.string().optional(),
  })
  .strict();
export type RulePack = z.infer<typeof packSchema>;
export type RulePackInput = z.input<typeof packSchema>;

export const customerSettingSchema = z
  .object({
    settingId: z.string().min(1),
    customerId: z.string().min(1),
    ruleCode: code,
    values: z.record(z.unknown()),
    status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED']).default('ACTIVE'),
    effectiveFrom: isoDate.nullable().default(null),
    effectiveTo: isoDate.nullable().default(null),
    version: z.number().int().min(1).default(1),
  })
  .strict();
export type CustomerSetting = z.infer<typeof customerSettingSchema>;
export type CustomerSettingInput = z.input<typeof customerSettingSchema>;

// ---------- runtime inputs ----------
export interface MxpEvent {
  id: string;
  type: string;
  customerId: string;
  accountId?: string | null;
  /** ISO-8601 instant. */
  timestamp: string;
  /** Id of an earlier event this one reverses (refund, reversal, rejected approval). */
  reversalOf?: string | null;
  [attr: string]: unknown;
}

export interface EvalContext {
  customer: { id: string; segment?: string | null; timezone?: string | null; [k: string]: unknown };
  account?: { id: string; [k: string]: unknown } | null;
  /** The customer's spend-control settings (all versions may be passed; the engine picks the one effective on the event date). */
  settings?: CustomerSettingInput[];
  /** Rule codes of OPT_IN missions the customer joined. */
  enrollments?: string[];
}
