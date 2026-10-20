import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthGate } from '../shared/auth';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/testing">
      <AuthGate app="Testing app" theme="testing"><App /></AuthGate>
    </BrowserRouter>
  </StrictMode>,
);
