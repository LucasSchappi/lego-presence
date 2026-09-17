// What a driver shows on the phone: their camera, an animated Lego head that copies their
// face, a picture, or a name card. Everything except the camera is drawn on a canvas and
// sent as an ordinary video track, so the phone treats it like any other video.
//
// Each look is { kind, track, mirror, stop() }. `mirror` is only for the driver's own preview.

const LOOK_W = 640;
const LOOK_H = 480;
const MEDIAPIPE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

function nameHue(name) {
  let h = 0;
  for (const ch of name || '?') h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function initials(name) {
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '🙂';
  const first = (w) => [...w][0].toUpperCase();
  return words.length > 1 ? first(words[0]) + first(words[words.length - 1]) : first(words[0]);
}

function newCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = LOOK_W;
  canvas.height = LOOK_H;
  return canvas;
}

// A canvas that redraws on a timer. Redrawing matters even when nothing changes: a canvas
// that is never repainted sends no frames, so a phone that (re)connects later would stay black.
function canvasLook(kind, draw, everyMs = 250) {
  const canvas = newCanvas();
  const ctx = canvas.getContext('2d');
  const track = canvas.captureStream(Math.max(1, Math.round(1000 / everyMs))).getVideoTracks()[0];
  draw(ctx);
  const timer = setInterval(() => draw(ctx), everyMs);
  return { kind, track, mirror: false, stop() { clearInterval(timer); track.stop(); } };
}

function fillBackground(ctx, hue) {
  const g = ctx.createLinearGradient(0, 0, 0, LOOK_H);
  g.addColorStop(0, `hsl(${hue} 60% 60%)`);
  g.addColorStop(1, `hsl(${(hue + 25) % 360} 55% 38%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, LOOK_W, LOOK_H);
}

// ---- Camera ------------------------------------------------------------------

async function cameraLook() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA_CONSTRAINTS });
  const track = stream.getVideoTracks()[0];
  return { kind: 'camera', track, mirror: true, stop() { track.stop(); } };
}

// ---- Name card ---------------------------------------------------------------

function nameLook(name) {
  const hue = nameHue(name);
  return canvasLook('name', (ctx) => {
    fillBackground(ctx, hue);
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.beginPath();
    ctx.arc(LOOK_W / 2, 200, 110, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `hsl(${hue} 55% 35%)`;
    ctx.font = '600 96px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials(name), LOOK_W / 2, 206);
    ctx.fillStyle = '#fff';
    ctx.font = '600 44px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(name || 'Guest', LOOK_W / 2, 390, LOOK_W - 60);
  }, 500);
}

// ---- Picture -----------------------------------------------------------------

// Shrinks a chosen image file to a JPEG data URL small enough to keep in localStorage.
async function pictureFromFile(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 720 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function pictureLook(dataUrl, name) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const hue = nameHue(name);
  return canvasLook('picture', (ctx) => {
    // Blurred copy fills the frame; the whole picture sits on top, so nothing gets cropped
    // no matter what shape the phone's tile is.
    fillBackground(ctx, hue);
    const cover = Math.max(LOOK_W / img.width, LOOK_H / img.height);
    ctx.save();
    ctx.filter = 'blur(24px) brightness(0.7)';
    ctx.drawImage(img, (LOOK_W - img.width * cover) / 2, (LOOK_H - img.height * cover) / 2, img.width * cover, img.height * cover);
    ctx.restore();
    // Phone tiles are usually wider than 4:3 and crop the top and bottom, so fit the
    // picture inside the middle 16:9 band.
    const fit = Math.min(LOOK_W / img.width, (LOOK_W * 9 / 16) / img.height) * 0.92;
    const w = img.width * fit, h = img.height * fit;
    ctx.drawImage(img, (LOOK_W - w) / 2, (LOOK_H - h) / 2, w, h);
  }, 500);
}

// ---- Animated Lego head ------------------------------------------------------

let landmarkerPromise = null;

function loadFaceTracker() {
  landmarkerPromise ??= (async () => {
    const { FaceLandmarker, FilesetResolver } = await import(`${MEDIAPIPE}/vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${MEDIAPIPE}/wasm`);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: FACE_MODEL, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
    try {
      return await FaceLandmarker.createFromOptions(files, options('GPU'));
    } catch {
      return await FaceLandmarker.createFromOptions(files, options('CPU'));
    }
  })();
  landmarkerPromise.catch(() => { landmarkerPromise = null; }); // allow a retry
  return landmarkerPromise;
}

// Face values used by the head. Everything is in image terms as the phone sees it:
// "L"/"R" and x mean screen left/right, not the person's own left/right.
const FACE_KEYS = [
  'blinkL', 'blinkR', 'wideL', 'wideR', 'squintL', 'squintR', 'lookX', 'lookY',
  'browInner', 'browOuterL', 'browOuterR', 'browDownL', 'browDownR',
  'jaw', 'smileL', 'smileR', 'frownL', 'frownR', 'stretchL', 'stretchR',
  'pucker', 'funnel', 'press', 'upperUp', 'lowerDown', 'mouthX', 'puff', 'sneer',
  'yaw', 'pitch', 'roll',
];
const NEUTRAL_FACE = Object.fromEntries(FACE_KEYS.map((k) => [k, 0]));
const SIGNED_KEYS = new Set(['lookX', 'lookY', 'mouthX', 'yaw', 'pitch', 'roll']);

// How strongly each expression shows once measured from the person's resting face. Some of
// MediaPipe's scores barely move (frowns, cheek puffs), so they get a bigger push.
const FACE_GAIN = {
  blinkL: 1.8, blinkR: 1.8, wideL: 2.2, wideR: 2.2, squintL: 1.2, squintR: 1.2,
  browInner: 1.6, browOuterL: 1.8, browOuterR: 1.8, browDownL: 1.5, browDownR: 1.5,
  jaw: 1.25, smileL: 1.15, smileR: 1.15, frownL: 3, frownR: 3, stretchL: 1.8, stretchR: 1.8,
  pucker: 1.4, funnel: 1.6, press: 1.3, upperUp: 1.3, lowerDown: 1.4, mouthX: 3, puff: 2, sneer: 2.2,
};

function readFace(result, videoW, videoH) {
  const shapes = result.faceBlendshapes?.[0]?.categories;
  const lm = result.faceLandmarks?.[0];
  if (!shapes || !lm) return null;
  const s = {};
  for (const c of shapes) s[c.categoryName] = c.score;
  const v = (k) => s[k] ?? 0;
  // MediaPipe's "Left" is the person's left, which appears on the right of the image.
  const screenL = (k) => v(`${k}Right`);
  const screenR = (k) => v(`${k}Left`);
  const avg = (k) => (v(`${k}Left`) + v(`${k}Right`)) / 2;

  // Head pose from landmarks: nose (1), face edges (234 screen-left, 454 screen-right),
  // forehead (10), chin (152), outer eye corners (33 screen-left, 263 screen-right).
  const px = (i) => ({ x: lm[i].x * videoW, y: lm[i].y * videoH });
  const nose = px(1), left = px(234), right = px(454), top = px(10), chin = px(152);
  const eyeL = px(33), eyeR = px(263);

  return {
    blinkL: screenL('eyeBlink'), blinkR: screenR('eyeBlink'),
    wideL: screenL('eyeWide'), wideR: screenR('eyeWide'),
    squintL: screenL('eyeSquint'), squintR: screenR('eyeSquint'),
    // Looking towards the person's left moves the eyes to screen right.
    lookX: (v('eyeLookOutLeft') + v('eyeLookInRight') - v('eyeLookInLeft') - v('eyeLookOutRight')) / 2,
    lookY: (avg('eyeLookDown') - avg('eyeLookUp')),
    browInner: v('browInnerUp'),
    browOuterL: screenL('browOuterUp'), browOuterR: screenR('browOuterUp'),
    browDownL: screenL('browDown'), browDownR: screenR('browDown'),
    jaw: v('jawOpen'),
    smileL: screenL('mouthSmile'), smileR: screenR('mouthSmile'),
    frownL: screenL('mouthFrown'), frownR: screenR('mouthFrown'),
    stretchL: screenL('mouthStretch'), stretchR: screenR('mouthStretch'),
    pucker: v('mouthPucker'),
    funnel: v('mouthFunnel'),
    press: avg('mouthPress'),
    upperUp: avg('mouthUpperUp'),
    lowerDown: avg('mouthLowerDown'),
    mouthX: (v('mouthLeft') - v('mouthRight')) + (v('jawLeft') - v('jawRight')) * 0.6,
    puff: v('cheekPuff'),
    sneer: avg('noseSneer'),
    yaw: ((nose.x - left.x) / Math.max(1, right.x - left.x) - 0.5) * 2.5,
    pitch: ((nose.y - top.y) / Math.max(1, chin.y - top.y) - 0.55) * 4,
    roll: Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x),
  };
}

// Everyone's relaxed face scores differently (plenty of people "smile" or "frown" at rest),
// so expressions are measured from the person's own neutral face, learned over the first
// second of tracking and whenever they press "Reset face".
class FaceCalibration {
  constructor() { this.reset(); }

  reset() {
    this.samples = [];
    this.base = null;
  }

  get calibrating() { return !this.base; }

  apply(raw) {
    if (!this.base) {
      this.samples.push(raw);
      if (this.samples.length < 30) return { ...NEUTRAL_FACE, yaw: raw.yaw, pitch: raw.pitch, roll: raw.roll };
      this.base = {};
      for (const k of FACE_KEYS) {
        const sorted = this.samples.map((f) => f[k]).sort((x, y) => x - y);
        this.base[k] = sorted[Math.floor(sorted.length / 2)];
      }
      this.base.roll = 0; // a tilted head at startup is still a tilt
    }
    const out = {};
    for (const k of FACE_KEYS) {
      const value = raw[k], base = this.base[k];
      if (SIGNED_KEYS.has(k)) {
        out[k] = Math.max(-1.2, Math.min(1.2, (value - base) * (FACE_GAIN[k] ?? 1)));
        continue;
      }
      // If they relax further than they did while calibrating, slowly learn that.
      if (value < base) this.base[k] += (value - base) * 0.02;
      const scaled = ((value - base) / Math.max(0.25, 1 - base)) * (FACE_GAIN[k] ?? 1);
      out[k] = Math.max(0, Math.min(1, scaled));
    }
    return out;
  }
}

async function avatarLook(name) {
  const [camera, tracker] = await Promise.all([
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } }),
    loadFaceTracker(),
  ]);

  // The camera only feeds the face tracker; it is never sent. Some browsers only decode
  // video that is in the page, so keep it attached but invisible.
  const video = document.createElement('video');
  Object.assign(video.style, { position: 'fixed', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
  video.muted = true;
  video.playsInline = true;
  video.srcObject = camera;
  document.body.append(video);
  await video.play();

  const canvas = newCanvas();
  const ctx = canvas.getContext('2d');
  const track = canvas.captureStream(30).getVideoTracks()[0];
  const hue = nameHue(name);
  const calibration = new FaceCalibration();
  const shown = { ...NEUTRAL_FACE };
  let target = { ...NEUTRAL_FACE };
  let lastSeen = 0, lastFrame = -1, running = true;

  const frame = () => {
    if (!running) return;
    const now = performance.now();
    if (video.readyState >= 2 && video.currentTime !== lastFrame) {
      lastFrame = video.currentTime;
      try {
        const raw = readFace(tracker.detectForVideo(video, now), video.videoWidth, video.videoHeight);
        if (raw) { target = calibration.apply(raw); lastSeen = now; }
      } catch (err) {
        console.warn('face tracking', err);
      }
    }
    const lost = now - lastSeen > 700;
    if (lost) {
      // Nobody in view: doze off and glance around.
      target = { ...NEUTRAL_FACE, blinkL: 0.65, blinkR: 0.65, lookX: Math.sin(now / 1500) * 0.6 };
    }
    // Small changes are smoothed (less jitter); big ones come through almost at once.
    for (const k of FACE_KEYS) {
      const d = target[k] - shown[k];
      const base = k.startsWith('blink') ? 0.6 : 0.3;
      shown[k] += d * Math.min(0.9, base + Math.abs(d) * 2);
    }
    drawLegoHead(ctx, shown, hue);
    window.__avatar = { found: !lost, calibrating: calibration.calibrating, face: { ...shown } }; // for debugging and tests
    setTimeout(frame, 33); // timers (unlike requestAnimationFrame) keep running in a background tab
  };
  frame();

  return {
    kind: 'avatar',
    track,
    mirror: true,
    recalibrate: () => calibration.reset(),
    stop() {
      running = false;
      track.stop();
      camera.getTracks().forEach((t) => t.stop());
      video.remove();
    },
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

const clampTo = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function drawLegoHead(ctx, f, hue) {
  const YELLOW = '#ffcd03', YELLOW_DARK = '#d9a800', INK = '#1b1b1b';
  fillBackground(ctx, hue);

  // Scaled so the whole head, stud included, survives the phone cropping to 16:9.
  ctx.save();
  ctx.translate(LOOK_W / 2, LOOK_H / 2);
  ctx.scale(0.74, 0.74);

  // Torso and neck stay put; only the head turns.
  ctx.fillStyle = `hsl(${(hue + 180) % 360} 55% 42%)`;
  ctx.beginPath();
  ctx.moveTo(-120, 180); ctx.lineTo(120, 180);
  ctx.lineTo(175, 340); ctx.lineTo(-175, 340);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = YELLOW_DARK;
  roundRect(ctx, -60, 130, 120, 60, 10);
  ctx.fill();

  ctx.translate(f.yaw * 22, -30 + f.pitch * 12);
  ctx.rotate(f.roll);

  // Stud on top
  ctx.fillStyle = YELLOW_DARK;
  roundRect(ctx, -48 + f.yaw * 10, -178, 96, 44, 10);
  ctx.fill();
  ctx.fillStyle = YELLOW;
  roundRect(ctx, -48 + f.yaw * 10, -182, 96, 30, 10);
  ctx.fill();

  // Head, shaded on the side turned away; puffed cheeks bulge it out.
  const halfW = 150 + f.puff * 18;
  const shade = ctx.createLinearGradient(-halfW, 0, halfW, 0);
  shade.addColorStop(0, YELLOW_DARK);
  shade.addColorStop(clampTo(0.5 - f.yaw * 0.35, 0.05, 0.95), YELLOW);
  shade.addColorStop(1, YELLOW_DARK);
  ctx.fillStyle = shade;
  roundRect(ctx, -halfW, -150, halfW * 2, 290, 70 + f.puff * 30);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0,0,0,.18)';
  ctx.stroke();

  // Face features move further than the head outline, which reads as the head turning.
  ctx.translate(f.yaw * 45, f.pitch * 28);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const smile = (f.smileL + f.smileR) / 2;

  // Puffed cheeks and blush
  if (f.puff > 0.12) {
    ctx.strokeStyle = `rgba(150, 110, 0, ${Math.min(0.6, f.puff)})`;
    ctx.lineWidth = 5;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      // The outward-facing half of a circle on each cheek.
      const start = side < 0 ? Math.PI * 0.6 : -Math.PI * 0.4;
      ctx.arc(side * (96 + f.puff * 10), 48, 26 + f.puff * 16, start, start + Math.PI * 0.8);
      ctx.stroke();
    }
  }
  if (smile > 0.35) {
    ctx.fillStyle = `rgba(255, 110, 110, ${Math.min(0.45, (smile - 0.35) * 0.9)})`;
    for (const x of [-100, 100]) {
      ctx.beginPath();
      ctx.ellipse(x, 44, 28, 16, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Eyes
  for (const side of [-1, 1]) {
    const L = side < 0;
    const blink = L ? f.blinkL : f.blinkR;
    const wide = L ? f.wideL : f.wideR;
    const squint = L ? f.squintL : f.squintR;
    const x = side * 55 + f.lookX * 9;
    const y = -22 + f.lookY * 7;
    const size = 1 + wide * 0.5;
    const open = clampTo(1 - blink, 0, 1) * (1 - squint * 0.4);
    ctx.fillStyle = INK;
    ctx.strokeStyle = INK;
    if (open < 0.18) {
      // Closed: a happy arc when smiling, otherwise a flat line.
      ctx.lineWidth = 7;
      ctx.beginPath();
      if (smile > 0.4) ctx.arc(x, y + 8, 15, Math.PI * 1.15, Math.PI * 1.85);
      else { ctx.moveTo(x - 16, y); ctx.lineTo(x + 16, y); }
      ctx.stroke();
      continue;
    }
    ctx.beginPath();
    ctx.ellipse(x, y, 17 * size, 23 * size * open, 0, 0, Math.PI * 2);
    ctx.fill();
    if (open > 0.35) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x - 5 * size, y - 9 * size * open, 5 * size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Eyebrows: inner and outer ends move separately, so one raised brow, worried brows and
  // angry V brows all work.
  ctx.strokeStyle = INK;
  ctx.lineWidth = 9;
  for (const side of [-1, 1]) {
    const L = side < 0;
    const outerUp = L ? f.browOuterL : f.browOuterR;
    const down = L ? f.browDownL : f.browDownR;
    const lift = (L ? f.wideL : f.wideR) * 10;
    const innerY = clampTo(-72 - f.browInner * 36 - outerUp * 8 + down * 28 - lift, -128, -50);
    // Frowning drops the inner end and lifts the outer one: an angry V.
    const outerY = clampTo(-70 - outerUp * 38 - f.browInner * 8 - down * 12 - lift, -128, -50);
    ctx.beginPath();
    ctx.moveTo(side * 24, innerY);
    ctx.quadraticCurveTo(side * 54, (innerY + outerY) / 2 - 14 * (1 - down), side * 86, outerY);
    ctx.stroke();
  }

  // Nose scrunch
  if (f.sneer > 0.3) {
    ctx.lineWidth = 4;
    ctx.strokeStyle = `rgba(27, 27, 27, ${Math.min(0.8, f.sneer)})`;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 10, 8);
      ctx.lineTo(side * 20, 18);
      ctx.moveTo(side * 12, 20);
      ctx.lineTo(side * 22, 28);
      ctx.stroke();
    }
  }

  drawMouth(ctx, f, smile);
  ctx.restore();
}

function drawMouth(ctx, f, smile) {
  const INK = '#1b1b1b';
  const frown = (f.frownL + f.frownR) / 2;
  const stretch = (f.stretchL + f.stretchR) / 2;
  const narrow = Math.max(f.pucker, f.funnel);
  const cx = clampTo(f.mouthX, -1, 1) * 36;
  const y = 60;
  const half = 48 * (1 - narrow * 0.6) + smile * 12 + stretch * 24;
  const lx = cx - half - f.stretchL * 8;
  const rx = cx + half + f.stretchR * 8;
  // Corners go up with a smile and down with a frown, each side on its own (smirks).
  const ly = y - f.smileL * 28 + f.frownL * 30;
  const ry = y - f.smileR * 28 + f.frownR * 30;
  const open = Math.max(f.jaw, f.funnel * 0.5, f.lowerDown * 0.6);
  ctx.strokeStyle = INK;
  ctx.fillStyle = '#4a0d12';

  // Pursed lips: a kiss, or an "ooh" when open.
  if (narrow > 0.45 && smile < 0.35 && stretch < 0.35) {
    ctx.lineWidth = 7;
    ctx.beginPath();
    if (open > 0.12 || f.funnel > 0.45) {
      ctx.ellipse(cx, y + 4 + open * 10, 12 + (1 - narrow) * 10 + open * 6, 12 + open * 50 + f.funnel * 8, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.ellipse(cx, y + 2, 10, 13, 0, 0, Math.PI * 2);
    }
    ctx.stroke();
    return;
  }

  if (open < 0.1) {
    // Closed: bows down for a smile, up for a frown, flatter when lips are pressed.
    const bow = (smile * 30 - frown * 26) * (1 - f.press * 0.6);
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.quadraticCurveTo(cx, (ly + ry) / 2 + bow, rx, ry);
    ctx.stroke();
    return;
  }

  // Open. With a frown the corners sit low, which turns this into a sad open mouth.
  const cornerY = (ly + ry) / 2;
  // Sad: the top lip arches up and the bottom flattens, giving an upside-down open mouth.
  const sad = clampTo(frown - smile, 0, 1);
  const topCtl = cornerY - 6 + smile * 14 - sad * 60 - f.upperUp * 10;
  const bottomCtl = cornerY + 14 + open * 105 * (1 - sad * 0.55);
  // Midpoints of the two curves (a quadratic's midpoint sits halfway to its control point).
  const topY = (cornerY + topCtl) / 2;
  const bottomY = (cornerY + bottomCtl) / 2;
  const mouth = new Path2D();
  mouth.moveTo(lx, ly);
  mouth.quadraticCurveTo(cx, topCtl, rx, ry);
  mouth.quadraticCurveTo(cx, bottomCtl, lx, ly);
  mouth.closePath();
  ctx.fill(mouth);

  ctx.save();
  ctx.clip(mouth);
  ctx.fillStyle = '#fff';
  if (smile > 0.35 || stretch > 0.3 || f.upperUp > 0.45) ctx.fillRect(lx, topY - 60, rx - lx, 60 + 14);
  if (stretch > 0.4) ctx.fillRect(lx, bottomY - 13, rx - lx, 60);
  if (open > 0.3) {
    ctx.fillStyle = '#e0626f';
    ctx.beginPath();
    ctx.ellipse(cx, bottomY - 4, (rx - lx) * 0.28, 16, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.lineWidth = 6;
  ctx.stroke(mouth);
}

async function buildLook(kind, { name, picture }) {
  if (kind === 'camera') return cameraLook();
  if (kind === 'avatar') return avatarLook(name);
  if (kind === 'picture') return pictureLook(picture, name);
  return nameLook(name);
}
