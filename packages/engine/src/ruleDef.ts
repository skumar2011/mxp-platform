import { z } from 'zod';
import { groupSchema, emptyGroup } from './conditions';
import { canonicalJson, sha256 } from './util';

export const RULE_CATEGORIES = [
  'SPEND',
  'FREQUENCY',
  'BILL_PAYMENT',
  'BALANCE',
  'SAVINGS_GROWTH',
  'COMBINED',
  'ENGAGEMENT',
  'OTHER',
] as const;

export const METRIC_TYPES = ['COUNT', 'SUM', 'AVG_BALANCE', 'MIN_BALANCE', 'BALANCE_GROWTH'] as const;
export const BALANCE_METRICS = ['AVG_BALANCE', 'MIN_BALANCE', 'BALANCE_GROWTH'] as const;
export const PERIOD_TYPES = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'CAMPAIGN'] as const;
export const CONFLICT_POLICIES = ['CUMULATIVE', 'EXCLUSIVE_HIGHEST_POINTS', 'EXCLUSIVE_PRIORITY'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const nullableInt = z.number().int().nonnegative().nullable().default(null);

export const RuleDefinitionSchema = z.object({
  name: z.string().trim().min(3).max(120),
  description: z.string().max(1000).default(''),
  businessObjective: z.string().max(1000).default(''),
  category: z.enum(RULE_CATEGORIES),
  campaignCode: z.string().nullable().default(null),
  kind: z.enum(['GOAL', 'PER_EVENT', 'COMBINED']),

  /** Supported channels / products. Compiled into a cheap pre-filter. */
  scope: z
    .object({
      channels: z.array(z.string()).default([]),
      productCodes: z.array(z.string()).default([]),
    })
    .default({}),

  /** Customer and account level eligibility (segments, product, status). */
  eligibility: groupSchema.default(emptyGroup()),
  /** Which transactions (or, for balance goals, which accounts) count toward the goal. */
  qualifying: groupSchema.default(emptyGroup()),

  metric: z
    .object({
      type: z.enum(METRIC_TYPES),
      operator: z.enum(['GTE', 'GT']).default('GTE'),
    })
    .nullable()
    .default(null),

  period: z.object({
    type: z.enum(PERIOD_TYPES),
    timezone: z.string().default('Asia/Kolkata'),
    dateBasis: z.enum(['TXN_DATE', 'POSTING_DATE']).default('TXN_DATE'),
    lateGraceDays: z.number().int().min(0).max(31).default(0),
  }),

  /** Goal tiers. Thresholds are in INR for money metrics and a plain number for COUNT. */
  tiers: z
    .array(
      z.object({
        label: z.string().max(60).optional(),
        threshold: z.number().nonnegative(),
        points: z.number().int().nonnegative(),
      }),
    )
    .default([]),
  tierMode: z.enum(['CUMULATIVE', 'HIGHEST_ONLY']).default('CUMULATIVE'),

  perEvent: z
    .object({
      mode: z.enum(['FIXED', 'PER_AMOUNT']),
      points: z.number().int().positive(),
      perAmount: z.number().positive().optional(),
    })
    .nullable()
    .default(null),

  /**
   * Combined goals: the metric is the NUMBER of component goals the customer has
   * met in the period (a component is met when its achieved tier >= minTier).
   * Tier thresholds are therefore counts of met components, so "both goals met"
   * is a tier at threshold = number of components.
   */
  combined: z
    .object({
      components: z
        .array(z.object({ ruleCode: z.string().min(1), minTier: z.number().int().min(1).default(1) }))
        .min(1),
    })
    .nullable()
    .default(null),

  balancePolicy: z.object({ gapFill: z.enum(['NONE', 'CARRY_FORWARD']).default('NONE') }).default({}),

  limits: z
    .object({
      frequency: z.enum(['ONCE', 'RECURRING']).default('RECURRING'),
      maxOccurrences: z.number().int().positive().nullable().default(null),
      capPointsPerPeriod: nullableInt,
      capPointsLifetime: nullableInt,
    })
    .default({}),

  handling: z
    .object({
      reversal: z.enum(['CLAWBACK', 'GRANDFATHER']).default('CLAWBACK'),
      countStatuses: z.array(z.enum(['POSTED', 'PENDING'])).min(1).default(['POSTED']),
    })
    .default({}),

  priority: z.number().int().min(0).max(1000).default(100),
  conflict: z
    .object({
      group: z.string().max(40).nullable().default(null),
      policy: z.enum(CONFLICT_POLICIES).default('CUMULATIVE'),
    })
    .default({}),

  effective: z
    .object({
      from: isoDate.nullable().default(null),
      to: isoDate.nullable().default(null),
    })
    .default({}),

  nudges: z
    .object({
      enabled: z.boolean().default(true),
      nearTargetPct: z.number().min(1).max(99).default(80),
    })
    .default({}),

  /** On activation, replay existing master transactions for the open period. */
  backfill: z.boolean().default(false),
});

export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;
export type RuleDefinitionInput = z.input<typeof RuleDefinitionSchema>;

export function parseRuleDefinition(input: unknown): RuleDefinition {
  return RuleDefinitionSchema.parse(input);
}

export function isBalanceMetric(t: string | null | undefined): boolean {
  return !!t && (BALANCE_METRICS as readonly string[]).includes(t);
}

export function definitionHash(def: RuleDefinition): string {
  return sha256(canonicalJson(def));
}

export const RULE_CODE_RE = /^[A-Z][A-Z0-9_]{2,39}$/;
