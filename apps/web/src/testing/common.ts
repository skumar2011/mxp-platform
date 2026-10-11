export interface RuleRef { ruleCode: string; versionNo?: number; definition?: unknown }
export interface SimInput {
  name?: string;
  rules: RuleRef[];
  includeActive?: boolean;
  scenario: { timezone?: string; customer?: any; accounts: any[]; steps: any[]; asOf?: string };
  expected?: any;
}

export const blankInput = (): SimInput => ({
  name: '',
  rules: [],
  scenario: {
    timezone: 'Asia/Kolkata',
    customer: { type: 'RETAIL', kycStatus: 'FULL', status: 'ACTIVE', segments: [], nudgeConsent: true },
    accounts: [
      { ref: 'SAV-1', productCode: 'SAV_REGULAR' },
      { ref: 'CC-1', productCode: 'CC_GOLD' },
    ],
    steps: [],
  },
});

const KEY = 'mxp.sim.handoff';
/** Passes a scenario between pages (cases, matrix, rule page) to the playground without putting it in the URL. */
export const handoff = {
  put: (v: { input: SimInput; caseId?: string; name?: string }) => sessionStorage.setItem(KEY, JSON.stringify(v)),
  take: (): { input: SimInput; caseId?: string; name?: string } | null => {
    const s = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    try { return s ? JSON.parse(s) : null; } catch { return null; }
  },
};

export const refLabel = (r: RuleRef) => `${r.ruleCode}${r.definition ? ' (unsaved definition)' : r.versionNo ? ` v${r.versionNo}` : ' (live)'}`;

export const CATEGORY_TONE: Record<string, string> = {
  POSITIVE: 'green', NEGATIVE: 'gray', BOUNDARY: 'amber', DUPLICATE: 'blue', REVERSAL: 'red', REFUND: 'red', STATUS: 'violet', PERIOD: 'amber', CAP: 'violet', DATA: 'blue', COMBINED: 'green', ELIGIBILITY: 'gray', CUSTOM: 'gray',
};

export const CATEGORIES = ['POSITIVE', 'NEGATIVE', 'BOUNDARY', 'DUPLICATE', 'REVERSAL', 'REFUND', 'STATUS', 'PERIOD', 'CAP', 'DATA', 'COMBINED', 'ELIGIBILITY', 'CUSTOM'];
