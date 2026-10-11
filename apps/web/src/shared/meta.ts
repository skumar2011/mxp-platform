import { api } from './api';

export interface Meta {
  env: string;
  fields: { path: string; label: string; scope: string; type: string; valuesFrom?: string; values?: string[]; description?: string }[];
  operators: { code: string; label: string }[];
  operatorsByType: Record<string, string[]>;
  accountTypes: string[];
  txnStatuses: string[];
  metricTypes: string[];
  periodTypes: string[];
  conflictPolicies: string[];
  ruleCategories: string[];
  roles: string[];
  reference: {
    channels: { code: string; name: string }[];
    products: { code: string; name: string; family: string }[];
    txnTypes: { code: string; name: string }[];
    categories: { code: string; name: string }[];
    segments: { code: string; name: string }[];
  };
}

let cached: Promise<Meta> | null = null;
export const loadMeta = () => (cached ??= api<Meta>('/meta').catch((e) => { cached = null; throw e; }));

/** Allowed values for an enum-like field (from the field catalog or the reference tables). */
export function valuesFor(meta: Meta, path: string): { code: string; name?: string }[] | null {
  const f = meta.fields.find((x) => x.path === path);
  if (!f) return null;
  if (f.values) return f.values.map((v) => ({ code: v }));
  const r = meta.reference;
  switch (f.valuesFrom) {
    case 'txn_types': return r.txnTypes;
    case 'categories': return r.categories;
    case 'channels': return r.channels;
    case 'products': return r.products;
    case 'segments': return r.segments;
    case 'product_families': return meta.accountTypes.map((c) => ({ code: c }));
  }
  return null;
}
