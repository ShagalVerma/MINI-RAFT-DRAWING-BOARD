import { WebSocketServer } from 'ws';
import fetch               from 'node-fetch';
import express             from 'express';

const REPLICAS  = process.env.REPLICAS.split(',').filter(Boolean);
// BONUS: REPLICAS_PUBLIC is the host:port list the *browser* uses to reach each
// replica directly (for the per-replica status polling and partition-admin
// buttons). Falls back to deriving from REPLICAS if not provided so existing
// 3-node deployments continue to work unchanged.
const REPLICAS_PUBLIC = (process.env.REPLICAS_PUBLIC || REPLICAS.map(u => {
  try { const x = new URL(u); return `${x.hostname}:${x.port}`; } catch { return u; }
}).join(',')).split(',').filter(Boolean);
const WS_PORT   = 8080;
const HTTP_PORT = 8081;

// ── Leader state ──────────────────────────────────────────────────────────────
let currentLeader          = null;
let isLeaderValid          = false;
let leaderDiscoveryPromise = null;
let leaderValidUntil       = 0;

// ── Client & canvas state ─────────────────────────────────────────────────────
const clients        = new Set();
const canvasLog      = [];   // replay buffer for late-joining clients
const pendingStrokes = [];

// ── Leader discovery ──────────────────────────────────────────────────────────
async function findLeader() {
  for (const url of REPLICAS) {
    try {
      const res = await fetch(`${url}/status`, { signal: AbortSignal.timeout(300) });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.role === 'leader') {
        console.log(`[Gateway] Leader found: ${url}`);
        return url;
      }
    } catch (_) { /* replica down — try next */ }
  }
  return null;
}

async function ensureLeader(retries = 20) {
  if (currentLeader && isLeaderValid && Date.now() < leaderValidUntil) {
    return currentLeader;
  }
  if (leaderDiscoveryPromise) return leaderDiscoveryPromise;

  leaderDiscoveryPromise = (async () => {
    for (let i = 0; i < retries; i++) {
      const found = await findLeader();
      if (found) {
        currentLeader    = found;
        isLeaderValid    = true;
        leaderValidUntil = Date.now() + 2000;
        console.log(`[Gateway] Leader set: ${currentLeader}`);
        if (pendingStrokes.length > 0) {
          console.log(`[Gateway] Draining ${pendingStrokes.length} pending strokes`);
          const toSend = pendingStrokes.splice(0);
          for (const stroke of toSend) await forwardToLeader(stroke);
        }
        leaderDiscoveryPromise = null;
        return currentLeader;
      }
      await new Promise(r => setTimeout(r, 300));
    }
    leaderDiscoveryPromise = null;
    console.log('[Gateway] Could not find a leader after retries');
    return null;
  })();

  return leaderDiscoveryPromise;
}

// ── Forward stroke to leader ──────────────────────────────────────────────────
async function forwardToLeader(stroke, maxAttempts = 10) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const leader = await ensureLeader(20);
    if (!leader) {
      pendingStrokes.push(stroke);
      return false;
    }
    try {
      const res = await fetch(`${leader}/stroke`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify(stroke),
        signal : AbortSignal.timeout(2000),
      });

      if (res.status === 307) {
        const data = await res.json();
        if (data.redirect) {
          currentLeader    = data.redirect;
          isLeaderValid    = true;
          leaderValidUntil = Date.now() + 2000;
        } else {
          currentLeader = null;
          isLeaderValid = false;
        }
        continue;
      }

      if (!res.ok) {
        console.log(`[Gateway] Leader ${leader} returned ${res.status} — re-discovering`);
        currentLeader = null;
        isLeaderValid = false;
        continue;
      }
      return true;
    } catch (err) {
      console.log(`[Gateway] Forward attempt ${attempt + 1} failed: ${err.message}`);
      currentLeader = null;
      isLeaderValid = false;
    }
  }
  console.log('[Gateway] Dropped stroke after max attempts');
  return false;
}

// ── Broadcast to all WebSocket clients ───────────────────────────────────────
function broadcastToClients(message) {
  const dead = [];
  let sent   = 0;
  for (const ws of clients) {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(message)); sent++; }
      catch (_) { dead.push(ws); }
    } else {
      dead.push(ws);
    }
  }
  dead.forEach(ws => clients.delete(ws));
  return sent;
}

// ── Replay canvas state to a new client ──────────────────────────────────────
async function replayCanvasToClient(ws) {
  if (canvasLog.length === 0) return;
  console.log(`[Gateway] Replaying ${canvasLog.length} strokes to new client`);
  for (const stroke of canvasLog) {
    if (ws.readyState !== 1) break;
    try { ws.send(JSON.stringify(stroke)); } catch (_) { break; }
  }
}

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', async (ws) => {
  clients.add(ws);
  console.log(`[Gateway] Client connected (total: ${clients.size})`);
  await replayCanvasToClient(ws);

  ws.on('message', async (raw) => {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    await forwardToLeader(message);
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[Gateway] Client disconnected (total: ${clients.size})`);
  });
  ws.on('error', () => clients.delete(ws));
});

// ── HTTP endpoints (called by replicas) ──────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

// Called by the leader after committing a stroke / undo / redo / clear.
// canvasLog is the ordered event stream replayed to late-joining clients —
// strokes, undos and redos all live in it so a fresh tab reconstructs the
// exact same canvas as everyone else (bonus: vector-based undo/redo via log
// compensation; the actual visibility computation happens on the client by
// scanning the event stream).
app.post('/broadcast', (req, res) => {
  const message = req.body;
  if (message?.type === 'noop') {
    res.json({ ok: true, sent: 0 });
    return;
  }
  // On a 'clear' event, wipe canvasLog (including any pending undo/redo
  // entries — they refer to strokes that no longer exist) and broadcast the
  // clear command so every client's canvas is wiped.
  if (message.type === 'clear') {
    canvasLog.length = 0;
    broadcastToClients({ type: 'clear' });
    console.log(`[Gateway] Broadcast CLEAR to clients`);
    res.json({ ok: true, sent: clients.size });
    return;
  }
  // Strokes (no type) AND undo/redo events go into the replay log so new
  // clients see the exact same final canvas state.
  if (message && (!message.type || message.type === 'undo' || message.type === 'redo')) {
    canvasLog.push(message);
  }
  const sent = broadcastToClients(message);
  console.log(`[Gateway] Broadcast ${message.type ?? 'stroke'} to ${sent} clients (log size: ${canvasLog.length})`);
  res.json({ ok: true, sent });
});

// Called by a newly elected leader
app.post('/leader-announce', (req, res) => {
  const { leader } = req.body;
  if (!leader) return res.status(400).json({ error: 'leader required' });
  console.log(`[Gateway] Leader announced: ${leader}`);
  currentLeader          = leader;
  isLeaderValid          = true;
  leaderValidUntil       = Date.now() + 2000;
  leaderDiscoveryPromise = null;
  res.json({ ok: true });
});

// Healthcheck
app.get('/health', (req, res) => {
  res.json({
    status        : 'ok',
    clients       : clients.size,
    leader        : currentLeader,
    pendingStrokes: pendingStrokes.length,
    canvasLogSize : canvasLog.length,
  });
});

// Permissive CORS so the static frontend (served by nginx on :3000) can reach
// these gateway endpoints from the browser. Only applied to GETs we actually
// expose for the dashboard.
function cors(_req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  next();
}

// BONUS: Browser-facing replica list for the dashboard. The frontend hits this
// once on load and dynamically renders one card per replica — adding/removing
// replicas no longer requires changing HTML.
app.get('/replicas', cors, (req, res) => {
  const list = REPLICAS_PUBLIC.map((hostPort, i) => {
    const [host, port] = hostPort.split(':');
    return {
      id    : host,
      host,
      port  : parseInt(port, 10),
      index : i + 1,
    };
  });
  res.json({ replicas: list, clusterSize: list.length, majority: Math.floor(list.length / 2) + 1 });
});

// BONUS: Aggregated cluster snapshot — single round-trip for the dashboard.
// Useful for the "leader, term, log sizes at a glance" overview required by
// the bonus dashboard challenge.
app.get('/cluster', cors, async (req, res) => {
  const snaps = await Promise.all(REPLICAS.map(async (url) => {
    try {
      const r = await fetch(`${url}/status`, { signal: AbortSignal.timeout(800) });
      const data = await r.json();
      return { url, alive: true, ...data };
    } catch (_) {
      return { url, alive: false };
    }
  }));
  const leader = snaps.find(s => s.role === 'leader') || null;
  res.json({
    leader        : leader ? { id: leader.id, term: leader.term, url: leader.url } : null,
    cachedLeader  : currentLeader,
    pendingStrokes: pendingStrokes.length,
    clients       : clients.size,
    canvasLogSize : canvasLog.length,
    replicas      : snaps,
  });
});

// ── FIX: Rebuild canvasLog correctly after gateway restart ────────────────────
// The replica's /log endpoint now returns entries starting AFTER the last
// committed 'clear' entry (see replica fix). This means rebuildCanvasLog will
// only replay strokes that are actually visible on the current canvas — it will
// not replay strokes that were wiped by a 'clear' command.
//
// Previously: /log?from=0 returned ALL log entries including pre-clear strokes,
// so a new client connecting after a gateway restart would see ghost strokes
// that the canvas had already cleared.
async function rebuildCanvasLog() {
  console.log('[Gateway] Attempting to rebuild canvasLog from leader...');
  const leader = await ensureLeader(30);
  if (!leader) {
    console.log('[Gateway] No leader available — canvasLog will be empty until first stroke');
    return;
  }
  try {
    // The leader's /log endpoint now filters out entries before the last clear.
    // We still pass from=0 as a base; the replica enforces the clear boundary.
    const res = await fetch(`${leader}/log?from=0`, { signal: AbortSignal.timeout(3000) });
    const { entries, lastClearIndex } = await res.json();
    canvasLog.length = 0;
    for (const e of entries) {
      if (e.data && e.data.type !== 'noop' && e.data.type !== 'clear') {
        canvasLog.push(e.data);
      }
    }
    console.log(
      `[Gateway] Rebuilt canvasLog: ${canvasLog.length} strokes from ${leader}` +
      (lastClearIndex >= 0 ? ` (skipped entries before clear@${lastClearIndex})` : '')
    );
  } catch (err) {
    console.log(`[Gateway] Could not rebuild canvasLog: ${err.message}`);
  }
}

app.listen(HTTP_PORT, () => {
  console.log(`[Gateway] HTTP on :${HTTP_PORT}  WebSocket on :${WS_PORT}`);
  rebuildCanvasLog();
});