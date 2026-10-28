import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  checkRule, checkTemplate, describeRule, parseRule, parseTemplate, validatePack,
  type Issue, type Rule, type RulePack, type RulePackInput, type RuleTemplate,
} from '@mxp/rules';
import { saveJson } from '../../shared/api';
import { useDebounced } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { FamilyBadge, formatValue, IssueList } from '../../shared/rules-ui';
import { Alert, Badge, Button, Card, DataTable } from '../../shared/ui';
import { PackPicker, usePack } from '../pack';

type Checked =
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'RulePack'; pack: RulePack | null; issues: (Issue & { doc?: string })[] }
  | { kind: 'Rule'; rule: Rule | null; template?: RuleTemplate; issues: Issue[] }
  | { kind: 'RuleTemplate'; template: RuleTemplate | null; issues: Issue[] };

/**
 * Rule file lab: paste or upload any rule file (a whole pack, one rule, or one template),
 * validate it with the same code the server and the engine use, then try it in the simulator
 * without touching the database.
 */
export function Lab() {
  const { engine, useFile } = usePack();
  const nav = useNavigate();
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const deb = useDebounced(text, 250);

  const checked = useMemo<Checked>(() => {
    if (!deb.trim()) return { kind: 'empty' };
    let doc: any;
    try { doc = JSON.parse(deb); } catch (e) { return { kind: 'error', message: `Not valid JSON: ${(e as Error).message}` }; }
    if (doc?.kind === 'RulePack') { const r = validatePack(doc); return { kind: 'RulePack', pack: r.pack, issues: r.issues }; }
    if (doc?.kind === 'Rule') {
      const r = parseRule(doc);
      if (!r.rule) return { kind: 'Rule', rule: null, issues: r.issues };
      const template = engine?.getTemplate(r.rule.template);
      return { kind: 'Rule', rule: r.rule, template, issues: checkRule(r.rule, template, engine?.references ?? {}) };
    }
    if (doc?.kind === 'RuleTemplate') {
      const r = parseTemplate(doc);
      if (!r.template) return { kind: 'RuleTemplate', template: null, issues: r.issues };
      return { kind: 'RuleTemplate', template: r.template, issues: engine ? checkTemplate(r.template, engine.references) : r.issues };
    }
    return { kind: 'error', message: 'Unknown document. Rule files have "kind": "RulePack", "Rule" or "RuleTemplate".' };
  }, [deb, engine]);

  const base = engine?.pack;
  const tryPack = (pack: RulePackInput, label: string, to: string) => {
    const v = validatePack(pack);
    if (!v.ok) { setText(JSON.stringify(pack, null, 2)); return; }
    useFile(pack, label);
    nav(to);
  };
  const withRule = (rule: Rule, template?: RuleTemplate): RulePackInput => ({
    ...base!, version: `${base!.version}+lab`,
    templates: template ? [...base!.templates.filter((t) => t.code !== template.code), template] : base!.templates,
    rules: [...base!.rules.filter((r) => r.code !== rule.code), rule],
  });
  const sampleRuleFor = (t: RuleTemplate): Rule => ({
    kind: 'Rule', code: `${t.code}_LAB`.slice(0, 40), version: 1, template: t.code, name: `${t.name} (lab)`, description: 'Sample instance generated in the rule lab.', status: 'ACTIVE',
    segments: [], states: [], productScope: 'ANY', enrollment: 'AUTO', priority: 100, featured: false, tags: ['lab'], effective: { from: null, to: null }, settingsPolicy: { changeEffective: 'IMMEDIATE', cooldownDays: 0 },
    params: Object.fromEntries(t.params.filter((p) => p.setBy === 'BANK' && p.default !== undefined).map((p) => [p.name, p.default])),
    customerParams: {},
  });
  const load = (doc: unknown) => setText(JSON.stringify(doc, null, 2));

  const errors = 'issues' in checked ? checked.issues.filter((i) => i.severity === 'error').length : 0;

  return (
    <div className="stack">
      <PageHead title="Rule file lab" sub="Any app that embeds @mxp/rules consumes the same files. Paste or upload a pack, a single rule or a template, check it, and run it here before it goes through approval." />
      <PackPicker />
      <div className="split" style={{ alignItems: 'start' }}>
        <Card title="Rule file" actions={<>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); e.target.value = ''; }} />
          <Button small onClick={() => fileRef.current?.click()}>Upload</Button>
          {base && <Button small onClick={() => load(base)}>Current pack</Button>}
          {base && (
            <select className="input" style={{ width: 'auto', padding: '2px 6px' }} value="" onChange={(e) => {
              const [k, code] = e.target.value.split(':');
              if (k === 'r') load(base.rules.find((r) => r.code === code));
              if (k === 't') load(base.templates.find((t) => t.code === code));
            }}>
              <option value="">Load one document…</option>
              <optgroup label="Rules">{base.rules.map((r) => <option key={r.code} value={`r:${r.code}`}>{r.code}</option>)}</optgroup>
              <optgroup label="Templates">{base.templates.map((t) => <option key={t.code} value={`t:${t.code}`}>{t.code}</option>)}</optgroup>
            </select>
          )}
        </>}>
          <textarea className="input code" rows={30} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
            placeholder={'{\n  "kind": "Rule",\n  "code": "DSL_MASS",\n  "template": "DAILY_SPEND_LIMIT",\n  ...\n}'} />
          {text && <div className="row gap" style={{ marginTop: 8 }}><Button small onClick={() => { try { load(JSON.parse(text)); } catch { /* invalid json is reported on the right */ } }}>Format</Button><Button small onClick={() => { try { saveJson(JSON.parse(text), 'rule-file.json'); } catch { /* ignore */ } }}>Download</Button></div>}
        </Card>

        <div className="stack">
          {checked.kind === 'empty' && <Card title="How it works"><div className="muted stack">
            <p style={{ margin: 0 }}><strong>RulePack</strong>: the complete file an app loads: reference lists, templates and rules. Use it to test a whole release in the simulator, scenarios and matrix.</p>
            <p style={{ margin: 0 }}><strong>Rule</strong>: one bank configuration of a template (bank values, customer bounds, segments, dates). It is checked against the template in the selected pack and can be tried in place of the live version.</p>
            <p style={{ margin: 0 }}><strong>RuleTemplate</strong>: the logic and the parameters the bank or the customer fill in. A sample rule is generated from the defaults so you can try it straight away.</p>
          </div></Card>}
          {checked.kind === 'error' && <Alert tone="err">{checked.message}</Alert>}

          {checked.kind === 'RulePack' && (
            <Card title={<>Rule pack {checked.pack && <code>{checked.pack.pack} {checked.pack.version}</code>}</>} actions={checked.pack && <>
              <Button disabled={errors > 0} onClick={() => tryPack(checked.pack!, `${checked.pack!.pack} ${checked.pack!.version}`, '/')}>Simulate</Button>
              <Button variant="primary" disabled={errors > 0} onClick={() => tryPack(checked.pack!, `${checked.pack!.pack} ${checked.pack!.version}`, '/matrix')}>Run matrix</Button>
            </>}>
              <div className="stack">
                <IssueList issues={checked.issues} />
                {checked.pack && <DataTable rows={checked.pack.rules} rowKey={(r) => r.code} cols={[
                  { key: 'c', header: 'Rule', render: (r) => <><strong>{r.code}</strong><div className="muted" style={{ fontSize: 12 }}>{r.name}</div></> },
                  { key: 'f', header: 'Family', render: (r) => { const t = checked.pack!.templates.find((x) => x.code === r.template); return t ? <FamilyBadge family={t.family} /> : <Badge tone="red">no template</Badge>; } },
                  { key: 's', header: 'Segments', render: (r) => r.segments.join(', ') || 'all' },
                  { key: 'd', header: 'Summary', render: (r) => { const t = checked.pack!.templates.find((x) => x.code === r.template); return <span className="muted">{t ? describeRule(r, t, undefined, checked.pack!.currency) : '-'}</span>; } },
                ]} />}
              </div>
            </Card>
          )}

          {checked.kind === 'Rule' && (
            <Card title={<>Rule {checked.rule && <code>{checked.rule.code}</code>} {checked.template && <FamilyBadge family={checked.template.family} />}</>}
              actions={checked.rule && checked.template && base && <Button variant="primary" disabled={errors > 0} onClick={() => tryPack(withRule(checked.rule!), `${checked.rule!.code} (lab)`, `/?rule=${checked.rule!.code}`)}>Try in simulator</Button>}>
              <div className="stack">
                <IssueList issues={checked.issues} />
                {checked.rule && checked.template && <>
                  <Alert tone="info">{describeRule(checked.rule, checked.template)}</Alert>
                  <ParamTable template={checked.template} rule={checked.rule} />
                  <small className="muted">{base?.rules.some((r) => r.code === checked.rule!.code) ? `Replaces ${checked.rule.code} from the selected pack while you test.` : 'Added to the selected pack while you test.'} Nothing is saved; promote it through the admin console.</small>
                </>}
              </div>
            </Card>
          )}

          {checked.kind === 'RuleTemplate' && (
            <Card title={<>Template {checked.template && <code>{checked.template.code} v{checked.template.version}</code>} {checked.template && <FamilyBadge family={checked.template.family} />}</>}
              actions={checked.template && base && <Button variant="primary" disabled={errors > 0} onClick={() => { const r = sampleRuleFor(checked.template!); tryPack(withRule(r, checked.template!), `${checked.template!.code} (lab)`, `/?rule=${r.code}`); }}>Try with a sample rule</Button>}>
              <div className="stack">
                <IssueList issues={checked.issues} />
                {checked.template && <>
                  <div className="muted">{checked.template.description}</div>
                  <ParamTable template={checked.template} />
                  <small className="muted">The sample rule uses each bank parameter's default. If a parameter has no default the pack will not validate; edit the generated rule JSON on the left and try again.</small>
                </>}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function ParamTable({ template, rule }: { template: RuleTemplate; rule?: Rule }) {
  return (
    <DataTable rows={template.params} rowKey={(p) => p.name} cols={[
      { key: 'n', header: 'Parameter', render: (p) => <><strong>{p.label}</strong> <code>{p.name}</code></> },
      { key: 's', header: 'Set by', render: (p) => <Badge tone={p.setBy === 'CUSTOMER' ? 'blue' : 'violet'}>{p.setBy === 'CUSTOMER' ? 'customer' : 'bank'}</Badge> },
      { key: 't', header: 'Type', render: (p) => p.type },
      { key: 'v', header: rule ? 'Value / bounds' : 'Default', render: (p) => {
        if (!rule) return p.default !== undefined ? formatValue(p, p.default) : <span className="muted">none</span>;
        if (p.setBy === 'BANK') return formatValue(p, rule.params[p.name] ?? p.default);
        const b = rule.customerParams[p.name] ?? {};
        const parts = [b.min ?? p.min, b.max ?? p.max].map((x) => (x === undefined ? '…' : formatValue(p, x)));
        return <span>{['enum', 'enum[]'].includes(p.type) ? (b.options ?? p.options ?? []).join(', ') : `${parts[0]} – ${parts[1]}`}{(b.default ?? p.default) !== undefined && <span className="muted"> · default {formatValue(p, b.default ?? p.default)}</span>}</span>;
      } },
    ]} />
  );
}
