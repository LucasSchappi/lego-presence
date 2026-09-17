// Shared helpers for the three pages (drive / phone / base).
// Signalling uses the free PeerJS cloud server; media and data go peer-to-peer over WebRTC.

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
// A rolling log of everything that could explain a dropped call. The phone streams its
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

// PeerJS never gives up on a "disconnected" connection, and a closed tab only shows up as
// "disconnected". Wi-Fi hiccups look the same but usually recover within a few seconds,
// so only treat the connection as gone once it has stayed down for a while.
function watchIce(mediaConnection, onGone, graceMs = 15000) {
  const pc = mediaConnection.peerConnection;
  if (!pc) return;
  let timer = null;
  pc.addEventListener('iceconnectionstatechange', () => {
    const s = pc.iceConnectionState;
    clearTimeout(timer);
    if (s === 'failed' || s === 'closed') onGone();
    else if (s === 'disconnected') {
      timer = setTimeout(() => { diag.log(`gave up after ${graceMs / 1000}s disconnected`); onGone(); }, graceMs);
    }
  });
  // Chrome reports a dead connection as "failed" here well before the grace period runs out.
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed') { clearTimeout(timer); onGone(); }
  });
}

// ---- Video quality ----------------------------------------------------------

// 540p is plenty for a phone screen and leaves headroom when the picture is moving.
async function getCameraAndMic(contentHint) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30, max: 30 } },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  // "motion" tells the encoder to keep frames flowing rather than keep every frame sharp.
  stream.getVideoTracks().forEach((t) => { if ('contentHint' in t) t.contentHint = contentHint; });
  return stream;
}

// Caps the video bitrate and, when the network struggles, drops resolution instead of frames.
// A rotating camera changes the whole picture at once; without a cap the encoder bursts
// past what the Wi-Fi can carry and the video stalls.
function tuneVideo(mediaConnection, maxBitrate) {
  const pc = mediaConnection.peerConnection;
  if (!pc) return;
  const apply = async () => {
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      params.encodings[0].maxBitrate = maxBitrate;
      try {
        await sender.setParameters({ ...params, degradationPreference: 'maintain-framerate' });
      } catch {
        // Some browsers (Safari) reject degradationPreference; keep the bitrate cap anyway.
        try { await sender.setParameters(params); } catch (err) { console.warn('tuneVideo', err); }
      }
    }
  };
  pc.addEventListener('connectionstatechange', () => pc.connectionState === 'connected' && apply());
  if (pc.connectionState === 'connected') apply();
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

// Logs every state change on a WebRTC connection, and a stats line every few seconds.
function logConnection(pc, label, everyMs = 5000) {
  pc.addEventListener('iceconnectionstatechange', () => diag.log(`${label} ice ${pc.iceConnectionState}`));
  pc.addEventListener('connectionstatechange', async () => {
    diag.log(`${label} connection ${pc.connectionState}`);
    if (pc.connectionState === 'connected') {
      const report = await pc.getStats();
      diag.log(`${label} route ${describeRoute(report, selectedPair(report))}`);
    }
  });

  let last = {};
  const timer = setInterval(async () => {
    if (pc.connectionState === 'closed') return clearInterval(timer);
    const report = await pc.getStats().catch(() => null);
    if (!report) return;
    const parts = [];
    const pair = selectedPair(report);
    if (pair?.currentRoundTripTime != null) parts.push(`rtt ${Math.round(pair.currentRoundTripTime * 1000)}ms`);
    if (pair?.availableOutgoingBitrate) parts.push(`uplink est ${Math.round(pair.availableOutgoingBitrate / 1000)}kbps`);
    report.forEach((r) => {
      if (r.kind !== 'video') return;
      const prev = last[r.id];
      const secs = prev ? (r.timestamp - prev.timestamp) / 1000 || 1 : 0;
      if (r.type === 'outbound-rtp') {
        const kbps = prev ? Math.round(((r.bytesSent - prev.bytesSent) * 8) / 1000 / secs) : 0;
        parts.push(`send ${r.frameHeight || 0}p ${Math.round(r.framesPerSecond || 0)}fps ${kbps}kbps limit=${r.qualityLimitationReason ?? '?'}`);
      } else if (r.type === 'inbound-rtp') {
        const kbps = prev ? Math.round(((r.bytesReceived - prev.bytesReceived) * 8) / 1000 / secs) : 0;
        const lost = prev ? r.packetsLost - prev.packetsLost : 0;
        const freezes = r.freezeCount != null ? ` freezes=${r.freezeCount}` : '';
        parts.push(`recv ${r.frameHeight || 0}p ${Math.round(r.framesPerSecond || 0)}fps ${kbps}kbps lost+${lost}${freezes}`);
      } else if (r.type === 'remote-inbound-rtp') {
        parts.push(`far-end loss ${Math.round((r.fractionLost || 0) * 100)}%`);
      }
      last[r.id] = r;
    });
    if (parts.length) diag.log(`${label} ${parts.join(' | ')}`);
  }, everyMs);
}

// Summarises the incoming video on a connection, e.g. "540p · 30 fps · 900 kbps · 0% loss · 40 ms · direct".
function makeStatsReader(pc) {
  let last = null;
  return async () => {
    const report = await pc.getStats();
    let video = null;
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') video = r;
    });
    const pair = selectedPair(report);
    if (!video) return null;

    const now = { t: video.timestamp, bytes: video.bytesReceived, got: video.packetsReceived, lost: video.packetsLost };
    let kbps = 0, loss = 0;
    if (last) {
      const secs = (now.t - last.t) / 1000 || 1;
      kbps = Math.round(((now.bytes - last.bytes) * 8) / 1000 / secs);
      const got = now.got - last.got, lost = now.lost - last.lost;
      loss = got + lost > 0 ? Math.round((lost / (got + lost)) * 100) : 0;
    }
    last = now;

    const local = pair && report.get(pair.localCandidateId);
    const remote = pair && report.get(pair.remoteCandidateId);
    const route = !pair ? '?'
      : local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relayed'
      : local?.candidateType === 'host' && remote?.candidateType === 'host' ? 'same network'
      : 'direct';
    const rtt = pair?.currentRoundTripTime != null ? `${Math.round(pair.currentRoundTripTime * 1000)} ms` : '';
    const parts = [
      video.frameHeight ? `${video.frameHeight}p` : 'no video',
      `${Math.round(video.framesPerSecond || 0)} fps`,
      `${kbps} kbps`,
      `${loss}% loss`,
      rtt,
      route,
    ].filter(Boolean);
    return { text: parts.join(' · '), bad: loss >= 5 || (video.framesPerSecond || 0) < 10 };
  };
}
