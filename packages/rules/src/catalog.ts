/**
 * Built-in catalogue: rule templates for every spend control and bank-defined
 * mission in the MXP capability list, plus a sample bank configuration.
 * These are plain JSON rule files; hosts can ship their own instead.
 */
import DAILY_SPEND_LIMIT from '../catalog/templates/DAILY_SPEND_LIMIT.json';
import MONTHLY_SPEND_LIMIT from '../catalog/templates/MONTHLY_SPEND_LIMIT.json';
import CATEGORY_SPEND_LIMIT from '../catalog/templates/CATEGORY_SPEND_LIMIT.json';
import MERCHANT_RESTRICTION from '../catalog/templates/MERCHANT_RESTRICTION.json';
import TXN_TYPE_RESTRICTION from '../catalog/templates/TXN_TYPE_RESTRICTION.json';
import TIMING_RESTRICTION from '../catalog/templates/TIMING_RESTRICTION.json';
import AVG_BALANCE_DAYS from '../catalog/templates/AVG_BALANCE_DAYS.json';
import AVG_MONTHLY_BALANCE from '../catalog/templates/AVG_MONTHLY_BALANCE.json';
import UPI_TXN_COUNT from '../catalog/templates/UPI_TXN_COUNT.json';
import REFER_A_CUSTOMER from '../catalog/templates/REFER_A_CUSTOMER.json';
import ADDITIONAL_PRODUCT from '../catalog/templates/ADDITIONAL_PRODUCT.json';
import RD_PAYMENT_STREAK from '../catalog/templates/RD_PAYMENT_STREAK.json';
import RD_COMPLETION from '../catalog/templates/RD_COMPLETION.json';
import FD_RENEWAL from '../catalog/templates/FD_RENEWAL.json';
import DORMANCY_PREVENTION from '../catalog/templates/DORMANCY_PREVENTION.json';
import SPEND_DIVERSITY from '../catalog/templates/SPEND_DIVERSITY.json';
import SAMPLE from '../catalog/sample-bank.rules.json';
import { DEFAULT_REFERENCES } from './facts';
import type { RuleInput, RulePackInput, RuleTemplateInput } from './schema';

export const CATALOG_TEMPLATES = [
  DAILY_SPEND_LIMIT, MONTHLY_SPEND_LIMIT, CATEGORY_SPEND_LIMIT, MERCHANT_RESTRICTION, TXN_TYPE_RESTRICTION, TIMING_RESTRICTION,
  AVG_BALANCE_DAYS, AVG_MONTHLY_BALANCE, UPI_TXN_COUNT, REFER_A_CUSTOMER, ADDITIONAL_PRODUCT, RD_PAYMENT_STREAK, RD_COMPLETION,
  FD_RENEWAL, DORMANCY_PREVENTION, SPEND_DIVERSITY,
] as unknown as RuleTemplateInput[];

/** Templates marked as extensions in the capability overview. */
export const EXTENSION_TEMPLATES = ['FD_RENEWAL', 'DORMANCY_PREVENTION', 'SPEND_DIVERSITY'];

export const SAMPLE_RULES = SAMPLE.rules as unknown as RuleInput[];
export const SAMPLE_REFERENCES = SAMPLE.references as Record<string, string[]>;

/** A complete, self-contained sample rule pack (templates + rules + references). */
export function samplePack(version = '1.0.0'): RulePackInput {
  return {
    kind: 'RulePack',
    pack: SAMPLE.pack,
    version,
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    description: SAMPLE.description,
    references: { ...DEFAULT_REFERENCES, ...SAMPLE_REFERENCES },
    templates: structuredClone(CATALOG_TEMPLATES),
    rules: structuredClone(SAMPLE_RULES),
  };
}
