export const inr = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? '-' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);

export const num = (n: number | null | undefined) => (n === null || n === undefined ? '-' : new Intl.NumberFormat('en-IN').format(n));

export const pts = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `${n > 0 ? '+' : ''}${num(n)}`);

export const dt = (iso?: string | null) => {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
};

export const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : '-');

export const pretty = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Metric display: money metrics in rupees, counts as plain numbers. */
export const metricText = (v: number | null | undefined, type?: string | null) => (v === null || v === undefined ? '-' : type === 'COUNT' || type === 'PER_EVENT' ? num(v) : inr(v));

export const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'green', APPROVED: 'blue', PENDING_APPROVAL: 'amber', DRAFT: 'gray', PAUSED: 'amber', REJECTED: 'red', RETIRED: 'gray', SUPERSEDED: 'gray',
  AWARDED: 'green', ACHIEVED: 'green', REVERSED: 'red', IN_PROGRESS: 'blue', NOT_QUALIFYING: 'gray', INELIGIBLE: 'gray', NO_CHANGE: 'gray', CAPPED: 'amber', SUPPRESSED: 'amber',
  DATA_UNAVAILABLE: 'amber', PERIOD_CLOSED: 'gray', ERROR: 'red', PASSED: 'green', FAILED: 'red', NO_EXPECTATION: 'gray',
  PROCESSED: 'green', RECEIVED: 'blue', NORMALIZED: 'blue', PROCESSING: 'blue', SUSPENDED: 'amber', DEAD_LETTER: 'red', REJECTED_EVENT: 'red',
  SENT: 'green', ELIGIBLE: 'blue', CLOSED: 'gray', RECONCILED: 'green', MISMATCH: 'red', OPEN: 'blue', REQUESTED: 'amber',
  CLOSED_ACHIEVED: 'green', CLOSED_NOT_ACHIEVED: 'gray', CLOSED_SUPERSEDED: 'gray',
  AWARD: 'green', REVERSAL: 'red', ADJUSTMENT: 'amber',
};
