import type { Db, Row } from './db';
import type { CampaignRow } from './campaigns';
import type { RuleDefinition } from './ruleDef';
import { getCampaign } from './campaigns';
import { getVersion, getLiveRules, listVersions } from './ruleRepo';

// ---------------------------------------------------------------------
// Scenario language (JSON, so the testing app, API and saved cases share it)
// ---------------------------------------------------------------------
export type TxnStatus = 'PENDING' | 'POSTED' | 'REVERSED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'FAILED';

export interface SimRuleRef {
  ruleCode: string;
  /** Omit for the live version (or the latest when nothing is live). */
  versionNo?: number;
  /** Test an unsaved definition instead of a stored one. */
  definition?: unknown;
}

export interface SimCustomer {
  ref?: string;
  type?: 'RETAIL' | 'SME' | 'CORPORATE';
  kycStatus?: 'FULL' | 'MINIMAL' | 'PENDING';
  status?: 'ACTIVE' | 'INACTIVE' | 'CLOSED' | 'BLOCKED';
  segments?: string[];
  nudgeConsent?: boolean;
}

export interface SimAccount {
  ref: string;
  productCode: string;
  openedOn?: string;
  status?: 'ACTIVE' | 'DORMANT' | 'FROZEN' | 'CLOSED';
  instrumentRef?: string;
  /** Overrides the instrument created for the account (default depends on the product family). */
  instrumentType?: 'CREDIT_CARD' | 'DEBIT_CARD' | 'UPI_VPA' | 'WALLET' | 'NONE';
}

interface StepBase {
  label?: string;
}

export interface SimTxnStep extends StepBase {
  kind: 'TXN';
  id: string;
  /** ISO instant, or local "YYYY-MM-DD" / "YYYY-MM-DDTHH:mm" in the scenario timezone. */
  at: string;
  type: string;
  channel: string;
  amount: number;
  drCr?: 'D' | 'C';
  status?: TxnStatus;
  category?: string;
  accountRef?: string;
  instrumentRef?: string;
  productCode?: string;
  merchantId?: string;
  merchantName?: string;
  mcc?: string;
  postingDate?: string;
  attributes?: Record<string, string | number | boolean>;
  refundedAmount?: number;
  /** Redeliver the identical event this many extra times. */
  repeat?: number;
  /** Deliver the same transaction again under a different event id this many extra times. */
  resendAs?: number;
  /** When MXP receives the event, if later than the transaction time (late arrival). */
  receivedAt?: string;
}

export interface SimStatusStep extends StepBase {
  kind: 'STATUS';
  id: string;
  at: string;
  status: TxnStatus;
  refundedAmount?: number;
}

export interface SimReversalStep extends StepBase {
  kind: 'REVERSAL' | 'REFUND';
  id: string;
  original: string;
  at: string;
  amount?: number;
}

export interface SimBalanceStep extends StepBase {
  kind: 'BALANCE';
  account: string;
  date: string;
  /** Inclusive end of a flat range ("same balance every day from date to toDate"). */
  toDate?: string;
  balance: number;
}

export interface SimCloseStep extends StepBase {
  kind: 'CLOSE';
  at: string;
}

export type SimStep = SimTxnStep | SimStatusStep | SimReversalStep | SimBalanceStep | SimCloseStep;

export interface SimScenario {
  name?: string;
  timezone?: string;
  customer?: SimCustomer;
  accounts: SimAccount[];
  steps: SimStep[];
  /** Local date on which to take the final result. The clock is advanced there and periods are closed. */
  asOf?: string;
}

export interface SimExpected {
  totalPoints?: number;
  pointsByRule?: Record<string, number>;
  /** Highest tier credited in any period (0 = none). */
  achievedTier?: Record<string, number>;
  /** Final metric value (major units) of the latest progress row of a rule. */
  metric?: Record<string, number>;
  awards?: number;
  reversals?: number;
  noDuplicateAwards?: boolean;
  nudges?: Record<string, number>;
  rejectedEvents?: number;
  duplicateEvents?: number;
  /** Outcome of a rule at a particular step (index in steps). */
  outcomes?: { step: number; ruleCode: string; outcome: string }[];
  /** Final progress status of a rule's latest period. */
  progressStatus?: Record<string, string>;
}

export interface SimCheck {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface SimInput {
  name?: string;
  rules: SimRuleRef[];
  /** Also run every rule that is live in the source (to test interaction with production rules). */
  includeActive?: boolean;
  scenario: SimScenario;
  expected?: SimExpected;
}

export interface SimProgress {
  ruleCode: string;
  versionNo: number;
  periodKey: string;
  metric: number;
  count: number;
  amount: number;
  achievedTier: number;
  status: string;
  note: string | null;
}

export interface SimEval {
  ruleCode: string;
  versionNo: number;
  trigger: string;
  period: string | null;
  outcome: string;
  eligible: boolean;
  reasonCode: string | null;
  reasonText: string | null;
  metric: number | null;
  pointsTarget: number | null;
  pointsDelta: number;
  trace: unknown;
}

export interface SimLedger {
  ledgerId: number;
  ruleCode: string | null;
  type: string;
  points: number;
  period: string | null;
  slot: string | null;
  reason: string;
  text: string | null;
}

export interface SimNudge {
  type: string;
  channel: string;
  status: string;
  ruleCode: string | null;
  message: string;
  suppressReason: string | null;
}

export interface SimStepResult {
  index: number;
  kind: string;
  label?: string;
  at: string;
  description: string;
  ingest: { sourceEventId: string | null; status: string; processingStatus?: string; errors?: { code: string; message: string }[] }[];
  evaluations: SimEval[];
  ledger: SimLedger[];
  nudges: SimNudge[];
  progressBefore: SimProgress[];
  progressAfter: SimProgress[];
}

export interface SimResult {
  ok: boolean;
  error?: { code: string; message: string; details?: unknown };
  name?: string;
  rules: { ruleCode: string; versionNo: number; name: string; kind: string; draft: boolean }[];
  steps: SimStepResult[];
  final: {
    totalPoints: number;
    pointsByRule: Record<string, number>;
    awards: number;
    reversals: number;
    duplicateAwards: number;
    ledger: SimLedger[];
    progress: SimProgress[];
    nudges: SimNudge[];
    achievedTier: Record<string, number>;
    events: Record<string, number>;
    rejected: number;
    duplicates: number;
    asOf: string;
  } | null;
  checks: SimCheck[];
  passed: boolean | null;
  durationMs: number;
  log: string[];
}

// ---------------------------------------------------------------------
// Where rule definitions come from. The simulator only ever reads through this interface,
// so it can be backed by the production database (read-only) or by a remote service.
// ---------------------------------------------------------------------
export interface StoredRule {
  ruleCode: string;
  versionNo: number;
  status: string;
  def: RuleDefinition;
}

export interface RuleSource {
  referenceData(): Record<string, Row[]>;
  campaign(code: string): CampaignRow | undefined;
  rule(ruleCode: string, versionNo?: number): StoredRule | undefined;
  activeRules(): StoredRule[];
}

export const REFERENCE_TABLES = ['channel_ref', 'product_ref', 'txn_type_ref', 'txn_category_ref', 'segment', 'nudge_template'] as const;

export class DbRuleSource implements RuleSource {
  constructor(private readonly db: Db) {}

  referenceData() {
    const out: Record<string, Row[]> = {};
    for (const t of REFERENCE_TABLES) out[t] = this.db.all(`SELECT * FROM ${t}`);
    return out;
  }

  campaign(code: string) {
    return getCampaign(this.db, code);
  }

  rule(ruleCode: string, versionNo?: number): StoredRule | undefined {
    if (versionNo !== undefined) {
      const v = getVersion(this.db, ruleCode, versionNo);
      return v && { ruleCode, versionNo: v.versionNo, status: v.status, def: v.def };
    }
    const live = getLiveRules(this.db).find((r) => r.ruleCode === ruleCode);
    if (live) return { ruleCode, versionNo: live.versionNo, status: 'ACTIVE', def: live.def };
    const latest = listVersions(this.db, ruleCode)[0];
    if (!latest) return undefined;
    const v = getVersion(this.db, ruleCode, latest.versionNo)!;
    return { ruleCode, versionNo: v.versionNo, status: v.status, def: v.def };
  }

  activeRules(): StoredRule[] {
    return getLiveRules(this.db).map((r) => ({ ruleCode: r.ruleCode, versionNo: r.versionNo, status: 'ACTIVE', def: r.def }));
  }
}
