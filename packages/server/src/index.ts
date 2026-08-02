// Server bootstrap: Express (static client + config endpoints) + Socket.IO,
// wired to the game engine and the question bank (with sample-fixture fallback).
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import express from 'express';
import { Server } from 'socket.io';
import {
  DEFAULT_CLIP_DURATION_SECONDS,
  DEFAULT_CLIP_START_SECONDS,
  SOCKET_PATH,
} from '@music-trivia/shared';
import { loadQuestionBank } from './questions/bank.js';
import { RoomManager } from './net/rooms.js';
import { attachSocketServer } from './net/server.js';
import { loadRootEnv, readAppVersion } from './env.js';

loadRootEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_VERSION = readAppVersion();

const PORT = Number(process.env.PORT ?? 3001);
const CAST_RECEIVER_APP_ID = process.env.CAST_RECEIVER_APP_ID ?? '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173';
const CLIP_START_SECONDS = Number(process.env.CLIP_START_SECONDS ?? DEFAULT_CLIP_START_SECONDS);
const CLIP_DURATION_SECONDS = Number(
  process.env.CLIP_DURATION_SECONDS ?? DEFAULT_CLIP_DURATION_SECONDS,
);

// --- Question bank: real file if present, bundled fixture otherwise ---
const loaded = loadQuestionBank();
if (loaded.warning) {
  console.warn(`[startup] question bank ${loaded.warning}; falling back to bundled sample bank.`);
}
console.log(
  `[startup] bank source: ${loaded.source} (${loaded.bank.categories.length} categories)`,
);

const rooms = new RoomManager(loaded.bank, {
  clipStartSeconds: CLIP_START_SECONDS,
  clipDurationSeconds: CLIP_DURATION_SECONDS,
});

// --- HTTP + static client ---
const app = express();
app.get('/api/config', (_req, res) => {
  res.json({
    castReceiverAppId: CAST_RECEIVER_APP_ID,
    publicBaseUrl: PUBLIC_BASE_URL,
    appVersion: APP_VERSION,
  });
});
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    rooms: rooms.all().length,
    bankSource: loaded.source,
    categories: loaded.bank.categories.length,
  });
});
app.get('/api/cast-room', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ code: rooms.getPendingCastCode() });
});

// Serve the built client if present (player at /, receiver at /receiver.html).
const clientDist = join(__dirname, '../../client/dist');
const DEPLOY_VERSION = Date.now().toString(36);
if (existsSync(clientDist)) {
  // Redirect /receiver.html to a versioned URL so the Chromecast never serves
  // a cached copy — the version changes on every deploy.
  app.get('/receiver.html', (req, res) => {
    if (req.query.v === DEPLOY_VERSION) {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(join(clientDist, 'receiver.html'));
    } else {
      res.redirect(302, `/receiver.html?v=${DEPLOY_VERSION}`);
    }
  });
  app.use(express.static(clientDist));
  // SPA fallback for the player deep-link routes (/, /join?code=…).
  app.get(/^\/(join)?$/, (_req, res) => {
    res.sendFile(join(clientDist, 'index.html'));
  });
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  path: SOCKET_PATH,
  cors: { origin: true, credentials: true },
  // Mobile browsers throttle JS timers in backgrounded tabs, which starves the
  // Socket.IO heartbeat well before the player actually left. The default
  // (~45s combined) is too tight for someone who tabbed away for a minute —
  // give it real slack. (See net/server.ts DEFAULT_DISCONNECT_GRACE_MS for the
  // second layer.)
  pingInterval: 25_000,
  pingTimeout: 60_000,
});

attachSocketServer(io, rooms);

httpServer.listen(PORT, () => {
  console.log(`[startup] Music Trivia v${APP_VERSION} on :${PORT} (socket ${SOCKET_PATH})`);
});
