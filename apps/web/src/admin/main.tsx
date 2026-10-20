import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthGate } from '../shared/auth';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthGate app="Admin Console"><App /></AuthGate>
    </BrowserRouter>
  </StrictMode>,
);
