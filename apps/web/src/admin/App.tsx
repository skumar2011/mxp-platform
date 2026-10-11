import { Navigate, Route, Routes } from 'react-router-dom';
import type { NavItem } from '../shared/auth';
import { Layout } from '../shared/Layout';
import { Dashboard } from './pages/Dashboard';
import { RulesList } from './pages/RulesList';
import { RuleEditor } from './pages/RuleEditor';
import { RuleDetail } from './pages/RuleDetail';
import { Campaigns } from './pages/Campaigns';
import { Evaluations } from './pages/Evaluations';
import { Ledger } from './pages/Ledger';
import { Customers } from './pages/Customers';
import { Ingestion } from './pages/Ingestion';
import { Reconciliation } from './pages/Reconciliation';
import { Audit } from './pages/Audit';
import { Administration } from './pages/Administration';

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: '▦' },
  { to: '/rules', label: 'Rules', icon: '☰', section: 'Configure' },
  { to: '/campaigns', label: 'Campaigns', icon: '⚑', section: 'Configure' },
  { to: '/evaluations', label: 'Evaluations', icon: '✓', section: 'Rewards' },
  { to: '/ledger', label: 'XP ledger', icon: '◎', section: 'Rewards' },
  { to: '/customers', label: 'Customers', icon: '☺', section: 'Rewards', perm: 'customers:read' },
  { to: '/ingestion', label: 'Ingestion', icon: '⇩', section: 'Operate', perm: 'ops:read' },
  { to: '/reconciliation', label: 'Reconciliation', icon: '⚖', section: 'Operate', perm: 'ops:read' },
  { to: '/audit', label: 'Audit trail', icon: '☷', section: 'Govern', perm: 'audit:read' },
  { to: '/admin', label: 'Administration', icon: '⚙', section: 'Govern', perm: 'users:admin' },
];

export function App() {
  return (
    <Layout title="MXP Admin" mark="XP" nav={NAV} other={{ label: 'Testing app', href: '/testing/', perm: 'simulate' }}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/rules" element={<RulesList />} />
        <Route path="/rules/new" element={<RuleEditor />} />
        <Route path="/rules/:code" element={<RuleDetail />} />
        <Route path="/rules/:code/versions/:v/edit" element={<RuleEditor />} />
        <Route path="/campaigns" element={<Campaigns />} />
        <Route path="/evaluations" element={<Evaluations />} />
        <Route path="/ledger" element={<Ledger />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/customers/:ref" element={<Customers />} />
        <Route path="/ingestion" element={<Ingestion />} />
        <Route path="/reconciliation" element={<Reconciliation />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/admin" element={<Administration />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
