export const inr = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? '-' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);

export const num = (n: number | null | undefined) => (n === null || n === undefined ? '-' : new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n));

export const pts = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `${n > 0 ? '+' : ''}${num(n)}`);

export const dt = (iso?: string | null) => {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
};

export const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : '-');

export const pretty = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export const familyLabel = (f: string) => (f === 'SPEND_CONTROL' ? 'Spend control' : 'Mission');

export const STATUS_TONE: Record<string, string> = {
  // rule lifecycle
  ACTIVE: 'green', APPROVED: 'blue', PENDING_APPROVAL: 'amber', DRAFT: 'gray', PAUSED: 'amber', REJECTED: 'red', RETIRED: 'gray', SUPERSEDED: 'gray', CANCELLED: 'gray',
  // engine outcomes
  AWARDED: 'green', GOAL_MET: 'green', COMPLIANT: 'green', WITHIN_LIMIT: 'green', PROGRESS: 'blue', IN_PROGRESS: 'blue', WARNING: 'amber', BREACH: 'red', BREACHED: 'red',
  REVERSED: 'red', STREAK_BROKEN: 'red', CAPPED: 'amber', MISSED: 'gray', NO_ACTIVITY: 'gray', NOT_MATCHED: 'gray', NOT_ELIGIBLE: 'gray', NOT_ENROLLED: 'gray',
  INVALID_SETTING: 'red', DUPLICATE: 'gray', WINDOW_CLOSED: 'gray', OUT_OF_SCOPE: 'gray', NOT_EFFECTIVE: 'gray', CLOSED: 'gray',
  // decisions
  ALLOW: 'green', WARN: 'amber', ALERT: 'red', BLOCK: 'red',
  // misc
  PASSED: 'green', FAILED: 'red', PROCESSED: 'green', RECEIVED: 'blue', OPEN: 'blue', PENDING: 'amber', SENT: 'green', SUPPRESSED: 'gray',
  AWARD: 'green', CLAWBACK: 'red', ADJUSTMENT: 'amber', ENROLLED: 'green', OPTED_OUT: 'gray',
  MISSION: 'violet', SPEND_CONTROL: 'blue', BANK: 'violet', CUSTOMER: 'blue',
};
