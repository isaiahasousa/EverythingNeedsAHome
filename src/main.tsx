import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadLargeSave } from './state/store';
import './styles.css';

// Render once any autosave kept in IndexedDB is loaded (normally instant: most projects are in localStorage).
void loadLargeSave().finally(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
