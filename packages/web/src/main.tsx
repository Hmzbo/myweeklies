import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { hydrateOffline } from './sync';
import './styles.css';

// The offline replica (ADR 0019) loads before the first render: the queue
// must exist before any Today view decides what a failed fetch means.
hydrateOffline();

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker is registered explicitly: without this (or the
// virtual:pwa-register import) nothing ever installs it, and push
// notifications have nowhere to land.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      // Offline on first load, or a browser that refuses workers (e.g. some
      // in-app webviews): the app works fine without one.
      console.warn('service worker registration failed', error);
    });
  });
}
