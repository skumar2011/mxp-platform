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
  { to: '/rules', label: 'Rules', icon: '☰', section: 'Rules' },
  { to: '/rules/new', label: 'Create rule', icon: '+', section: 'Rules', end: true },
  { to: '/customers', label: 'Customers', icon: '☺', section: 'Operate', perm: 'customers:read' },
  { to: '/activity', label: 'Activity', icon: '≋', section: 'Operate', perm: 'customers:read' },
  { to: '/catalog', label: 'Templates', icon: '❖', section: 'More' },
  { to: '/packs', label: 'Live pack', icon: '⇪', section: 'More' },
  { to: '/segments', label: 'By segment', icon: '◫', section: 'More' },
  { to: '/audit', label: 'Audit', icon: '☷', section: 'More', perm: 'audit:read' },
];

export function App() {
  return (
    <Layout title="MXP Admin" mark="XP" nav={NAV} other={{ label: 'Test rules', href: '/testing/' }}>
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
