// Shared helpers for the three pages (drive / phone / base).
// Signalling uses the free PeerJS cloud server; commands and status go peer-to-peer over WebRTC.

const PEER_PREFIX = 'lego-presence-v1-';

const PEER_OPTIONS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  },
};

function cleanRoom(value) {
  return (value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
}

function peerIds(room) {
  return {
    phone: `${PEER_PREFIX}${room}-phone`,
    base: `${PEER_PREFIX}${room}-base`,
  };
}

// ---- Diagnostics -------------------------------------------------------------
// A rolling log of everything that could explain a dropped connection. The phone streams its
// log to the drive page, where "Diagnostics" shows both.

const diag = {
  lines: [],
  listeners: new Set(),
  log(msg) {
    const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
    this.lines.push(line);
    if (this.lines.length > 600) this.lines.shift();
    console.log('[diag]', msg);
    this.listeners.forEach((fn) => fn(line));
  },
};

diag.log(`open ${location.pathname.split('/').pop() || 'index'} · ${navigator.userAgent}`);
document.addEventListener('visibilitychange', () => diag.log(`page ${document.visibilityState}`));
addEventListener('pagehide', () => diag.log('page hide/unload'));
addEventListener('online', () => diag.log('browser online'));
addEventListener('offline', () => diag.log('browser OFFLINE'));
screen.orientation?.addEventListener('change', () => diag.log(`orientation ${screen.orientation.type}`));
navigator.connection?.addEventListener?.('change', () => {
  const c = navigator.connection;
  diag.log(`network changed ${c.type || ''} ${c.effectiveType || ''} ${c.downlink ?? ''}Mbps`);
});

// ---- Relay (TURN) -------------------------------------------------------------
// Direct connections often fail between different networks (mobile data, most home routers
// on both ends). A TURN relay carries the connection when that happens. Callers must
// `await iceReady` before creating a Peer so the relay is included.

const iceReady = (async () => {
  const url = window.PRESENCE_CONFIG?.turnCredentialsUrl;
  if (!url) {
    diag.log('no relay (TURN) configured: devices on different networks may fail to connect');
    return false;
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const servers = await res.json();
    if (!Array.isArray(servers) || !servers.length) throw new Error('no servers returned');
    PEER_OPTIONS.config.iceServers.push(...servers);
    diag.log(`relay ready (${servers.length} servers)`);
    return true;
  } catch (err) {
    diag.log(`relay credentials failed: ${err.message}`);
    return false;
  }
})();

// Returns the room from ?room=..., or shows the room form and returns null.
function getRoomOrShowForm() {
  const room = cleanRoom(new URLSearchParams(location.search).get('room'));
  if (room) {
    document.querySelectorAll('[data-room]').forEach((el) => (el.textContent = room));
    return room;
  }
  const form = document.getElementById('room-form');
  form.hidden = false;
  document.getElementById('app').hidden = true;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = cleanRoom(form.elements.room.value);
    if (!value) return;
    const url = new URL(location.href);
    url.searchParams.set('room', value);
    location.href = url.toString();
  });
  return null;
}

function setChip(id, text, state) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.dataset.state = state; // ok | wait | bad
}

function makePeer(id, onStatus) {
  const peer = id ? new Peer(id, PEER_OPTIONS) : new Peer(PEER_OPTIONS);
  peer.on('open', (got) => diag.log(`signalling open as ${got.replace(PEER_PREFIX, '')}`));
  peer.on('error', (err) => diag.log(`signalling error ${err.type}: ${err.message}`));
  peer.on('disconnected', () => {
    if (peer.destroyed) return;
    diag.log('signalling disconnected, reconnecting');
    onStatus?.('Reconnecting to signalling…', 'wait');
    setTimeout(() => !peer.destroyed && peer.reconnect(), 2000);
  });
  return peer;
}

// For the phone and base, whose IDs are fixed. After a reload the old registration lingers
// on the signalling server for up to a minute ("ID taken"), so keep retrying instead of giving up.
function makeFixedPeer(id, onStatus, setup) {
  const peer = makePeer(id, onStatus);
  peer.on('error', (err) => {
    if (err.type !== 'unavailable-id') return;
    peer.destroy();
    onStatus?.('Waiting for old session to clear…', 'wait');
    setTimeout(() => makeFixedPeer(id, onStatus, setup), 5000);
  });
  setup(peer);
  return peer;
}

async function keepAwake() {
  if (keepAwake.started) return;
  keepAwake.started = true;
  if (!('wakeLock' in navigator)) return diag.log('no wake lock support: the screen may sleep');
  const request = async () => {
    try {
      const lock = await navigator.wakeLock.request('screen');
      diag.log('screen wake lock on');
      lock.addEventListener('release', () => diag.log('screen wake lock released'));
    } catch (err) {
      diag.log(`screen wake lock refused: ${err.message}`);
    }
  };
  await request();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') request();
  });
}

function selectedPair(report) {
  let id = null, fallback = null;
  report.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) id = r.selectedCandidatePairId;
    if (r.type === 'candidate-pair' && r.selected) fallback = r;
  });
  return (id && report.get(id)) || fallback;
}

function describeRoute(report, pair) {
  if (!pair) return '?';
  const side = (c) => (c ? `${c.candidateType}/${c.protocol}${c.networkType ? '/' + c.networkType : ''}` : '?');
  return `${side(report.get(pair.localCandidateId))} ↔ ${side(report.get(pair.remoteCandidateId))}`;
}

// Logs every state change on a WebRTC connection, and the route it ends up taking.
function logConnection(pc, label) {
  pc.addEventListener('iceconnectionstatechange', () => diag.log(`${label} ice ${pc.iceConnectionState}`));
  pc.addEventListener('connectionstatechange', async () => {
    diag.log(`${label} connection ${pc.connectionState}`);
    if (pc.connectionState === 'connected') {
      const report = await pc.getStats();
      diag.log(`${label} route ${describeRoute(report, selectedPair(report))}`);
    }
  });
}
