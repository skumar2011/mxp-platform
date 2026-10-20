import { Navigate, Route, Routes } from 'react-router-dom';
import type { NavItem } from '../shared/auth';
import { Layout } from '../shared/Layout';
import { PackProvider } from './pack';
import { Simulator } from './pages/Simulator';
import { Scenarios } from './pages/Scenarios';
import { Matrix } from './pages/Matrix';
import { Lab } from './pages/Lab';

const NAV: NavItem[] = [
  { to: '/', label: 'Simulator', icon: '▶' },
  { to: '/scenarios', label: 'Scenarios', icon: '☑' },
  { to: '/matrix', label: 'Boundary matrix', icon: '▦' },
  { to: '/lab', label: 'Rule file lab', icon: '{ }' },
];

export function App() {
  return (
    <PackProvider>
      <Layout title="MXP Testing" mark="T" nav={NAV} other={{ label: 'Admin console', href: '/' }}>
        <Routes>
          <Route path="/" element={<Simulator />} />
          <Route path="/scenarios" element={<Scenarios />} />
          <Route path="/matrix" element={<Matrix />} />
          <Route path="/lab" element={<Lab />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </PackProvider>
  );
}
