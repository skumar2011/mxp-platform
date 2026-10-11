import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { AuthGate } from '../shared/auth';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <AuthGate app="Testing and Simulation" theme="testing"><App /></AuthGate>
    </HashRouter>
  </StrictMode>,
);
