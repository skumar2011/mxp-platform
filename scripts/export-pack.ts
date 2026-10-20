/**
 * Writes a self-contained rule pack file: the artefact any app embedding @mxp/rules loads.
 *
 *   npm run export:pack                       live release from data/mxp.db (falls back to the sample pack)
 *   npm run export:pack -- --sample           the built-in sample bank configuration
 *   npm run export:pack -- --out my.json      choose the output file (default examples/mxp-retail.pack.json)
 *   npm run export:pack -- --db path/to.db    read another database
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, validatePack, type RulePackInput } from '@mxp/rules';
import { samplePack } from '@mxp/rules/catalog';
import { Mxp, systemClock } from '@mxp/platform';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = resolve(root, opt('--out') ?? 'examples/mxp-retail.pack.json');
const dbPath = resolve(root, opt('--db') ?? process.env.MXP_DB ?? 'data/mxp.db');

let pack: RulePackInput;
let source: string;
if (!args.includes('--sample') && existsSync(dbPath)) {
  const mx = Mxp.open(dbPath, systemClock);
  const cur = mx.catalog.currentRelease();
  pack = cur ? JSON.parse(cur.content_json) : mx.catalog.buildPack();
  source = cur ? `release ${cur.version_label} from ${dbPath}` : `live rules in ${dbPath} (no release published)`;
  mx.close();
} else {
  pack = samplePack('sample-1');
  source = 'built-in sample bank configuration';
}

const check = validatePack(pack);
const errors = check.issues.filter((i) => i.severity === 'error');
if (errors.length) {
  for (const e of errors) console.error(`  ${e.doc ?? ''} ${e.path ?? ''}: ${e.message}`);
  console.error(`Not written: the pack has ${errors.length} error(s).`);
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(pack, null, 2)}\n`);
console.log(`Wrote ${out}`);
console.log(`  source: ${source}`);
console.log(`  ${pack.templates?.length ?? 0} templates, ${pack.rules?.length ?? 0} rules, fingerprint ${fingerprint({ ...pack, generatedAt: undefined }).slice(0, 16)}`);
if (check.issues.length) console.log(`  ${check.issues.length} warning(s); run it through the testing app's rule file lab to review them.`);
