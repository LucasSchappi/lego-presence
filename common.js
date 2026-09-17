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

// PeerJS is slow to notice when the other side vanishes (e.g. a closed tab), so
// treat a WebRTC connection that stays "disconnected" for a few seconds as gone.
function watchIce(mediaConnection, onGone, graceMs = 3000) {
  const pc = mediaConnection.peerConnection;
  if (!pc) return;
  let timer = null;
  pc.addEventListener('iceconnectionstatechange', () => {
    const s = pc.iceConnectionState;
    clearTimeout(timer);
    if (s === 'failed' || s === 'closed') onGone();
    else if (s === 'disconnected') timer = setTimeout(onGone, graceMs);
  });
}
