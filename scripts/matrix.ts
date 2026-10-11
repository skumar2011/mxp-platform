import { openDb, seedAll, DbRuleSource, generateMatrix, runScenario } from '../packages/engine/src/index';
const db = openDb(':memory:');
seedAll(db, new Date('2026-10-10T09:00:00Z'));
const src = new DbRuleSource(db);
let total = 0, failed = 0;
const only = process.argv[2];
for (const r of db.all<{ rule_code: string }>('SELECT rule_code FROM rule ORDER BY 1')) {
  if (only && r.rule_code !== only) continue;
  const m = generateMatrix(src, { ruleCode: r.rule_code });
  console.log(`\n== ${r.rule_code}: ${m.cases.length} cases`, m.notes.length ? m.notes : '');
  for (const c of m.cases) {
    const res = runScenario(src, { name: c.name, rules: c.rules, scenario: c.scenario, expected: c.expected });
    total++;
    if (!res.ok || !res.passed) {
      failed++;
      console.log(`  FAIL [${c.category}] ${c.name}`);
      if (!res.ok) console.log('     error', res.error);
      for (const k of res.checks.filter((x) => !x.pass)) console.log(`     ${k.name}: expected ${k.expected} got ${k.actual}`);
    }
  }
}
console.log(`\n${total - failed}/${total} passed`);
