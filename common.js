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
  peer.on('disconnected', () => {
    onStatus?.('Reconnecting to signalling…', 'wait');
    setTimeout(() => !peer.destroyed && peer.reconnect(), 2000);
  });
  return peer;
}

async function keepAwake() {
  if (!('wakeLock' in navigator)) return;
  const request = async () => {
    try { await navigator.wakeLock.request('screen'); } catch { /* not allowed right now */ }
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
    else if (s === 'disconnected') timer = setTimeout(onGone, graceMs);
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

// Summarises the incoming video on a connection, e.g. "540p · 30 fps · 900 kbps · 0% loss · 40 ms · direct".
function makeStatsReader(pc) {
  let last = null;
  return async () => {
    const report = await pc.getStats();
    let video = null, pair = null, selectedId = null;
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') video = r;
      if (r.type === 'transport' && r.selectedCandidatePairId) selectedId = r.selectedCandidatePairId;
    });
    report.forEach((r) => {
      if (r.type === 'candidate-pair' && (r.id === selectedId || (!selectedId && r.selected))) pair = r;
    });
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
