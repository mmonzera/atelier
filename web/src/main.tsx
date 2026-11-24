import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { BootLoader } from './components/BootLoader';
import { Toaster } from './components/Toast';
import { AuthGate } from './state/auth';
import { subscribeAnimationGate } from './state/animationGate';
import './styles/tokens.css';

// Start tracking focus/visibility right away so decorative animations sleep when unfocused.
subscribeAnimationGate(() => undefined);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
    <BootLoader />
    <Toaster />
  </StrictMode>,
);
