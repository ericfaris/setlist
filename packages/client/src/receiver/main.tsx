import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../common/styles.css';
import App from './App.js';
import { store } from '../common/store.js';

// Tell the server we're a receiver waiting for a room code. The server pushes
// cast:roomCode when the host casts (no Cast messaging needed).
store.receiverStandby();

// Also handle codes delivered via Cast custom messages (best-effort fallback).
(window as any).__castOnCode = (code: string) => void store.receiverSubscribe(code);
const pending = (window as any).__castPendingCode as string | null;
if (pending) void store.receiverSubscribe(pending);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
