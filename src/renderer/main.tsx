import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Application root element is missing.');

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
