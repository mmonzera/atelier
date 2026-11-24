import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { Toaster } from './components/Toast';
import { AuthGate } from './state/auth';
import './styles/tokens.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
    <Toaster />
  </StrictMode>,
);
