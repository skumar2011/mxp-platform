import { Navigate, Route, Routes } from 'react-router-dom';
import type { NavItem } from '../shared/auth';
import { Layout } from '../shared/Layout';
import { Dashboard } from './pages/Dashboard';
import { Catalog } from './pages/Catalog';
import { TemplateDetail } from './pages/TemplateDetail';
import { Rules } from './pages/Rules';
import { RuleEditor } from './pages/RuleEditor';
import { RuleDetail } from './pages/RuleDetail';
import { Segments } from './pages/Segments';
import { Customers } from './pages/Customers';
import { CustomerDetail } from './pages/CustomerDetail';
import { Activity } from './pages/Activity';
import { Packs } from './pages/Packs';
import { Audit } from './pages/Audit';

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: '▦' },
  { to: '/catalog', label: 'Rule catalogue', icon: '❖', section: 'Configure' },
  { to: '/rules', label: 'Bank rules', icon: '☰', section: 'Configure' },
  { to: '/segments', label: 'By segment', icon: '◫', section: 'Configure' },
  { to: '/packs', label: 'Rule packs', icon: '⇪', section: 'Configure' },
  { to: '/customers', label: 'Customers', icon: '☺', section: 'Operate', perm: 'customers:read' },
  { to: '/activity', label: 'Activity', icon: '≋', section: 'Operate', perm: 'customers:read' },
  { to: '/audit', label: 'Audit trail', icon: '☷', section: 'Govern', perm: 'audit:read' },
];

export function App() {
  return (
    <Layout title="MXP Admin" mark="XP" nav={NAV} other={{ label: 'Testing app', href: '/testing/' }}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/catalog" element={<Catalog />} />
        <Route path="/catalog/:code" element={<TemplateDetail />} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/rules/new" element={<RuleEditor />} />
        <Route path="/rules/:code" element={<RuleDetail />} />
        <Route path="/rules/:code/versions/:v/edit" element={<RuleEditor />} />
        <Route path="/segments" element={<Segments />} />
        <Route path="/packs" element={<Packs />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/customers/:id" element={<CustomerDetail />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
