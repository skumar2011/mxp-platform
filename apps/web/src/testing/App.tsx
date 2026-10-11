import { Navigate, Route, Routes } from 'react-router-dom';
import type { NavItem } from '../shared/auth';
import { Layout } from '../shared/Layout';
import { Cases } from './pages/Cases';
import { Matrix } from './pages/Matrix';
import { Performance } from './pages/Performance';
import { Playground } from './pages/Playground';
import { Preview } from './pages/Preview';
import { Suites } from './pages/Suites';

const NAV: NavItem[] = [
  { to: '/playground', label: 'Playground', icon: '▶', section: 'Simulate' },
  { to: '/matrix', label: 'Scenario matrix', icon: '▦', section: 'Simulate' },
  { to: '/preview', label: 'Real customers', icon: '☺', section: 'Simulate' },
  { to: '/cases', label: 'Test cases', icon: '☰', section: 'Library' },
  { to: '/suites', label: 'Regression runs', icon: '↻', section: 'Library' },
  { to: '/performance', label: 'Performance', icon: '⚡', section: 'Library' },
];

export function App() {
  return (
    <Layout title="MXP Testing" mark="T" nav={NAV} other={{ label: 'Admin console', href: '/' }}>
      <Routes>
        <Route path="/playground" element={<Playground />} />
        <Route path="/matrix" element={<Matrix />} />
        <Route path="/preview" element={<Preview />} />
        <Route path="/cases" element={<Cases />} />
        <Route path="/suites" element={<Suites />} />
        <Route path="/performance" element={<Performance />} />
        <Route path="*" element={<Navigate to="/playground" replace />} />
      </Routes>
    </Layout>
  );
}
