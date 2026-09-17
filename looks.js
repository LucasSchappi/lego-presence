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

const NEUTRAL_FACE = {
  blinkL: 0, blinkR: 0, lookX: 0, lookY: 0,
  jaw: 0, smileL: 0, smileR: 0, frown: 0, pucker: 0,
  browUp: 0, browDown: 0, yaw: 0, pitch: 0, roll: 0,
};

// Turns MediaPipe results into the handful of values the head needs. Everything is in
// image terms as the phone sees it: "L"/"R" and x are screen left/right, not the person's.
function readFace(result, videoW, videoH) {
  const shapes = result.faceBlendshapes?.[0]?.categories;
  const lm = result.faceLandmarks?.[0];
  if (!shapes || !lm) return null;
  const s = {};
  for (const c of shapes) s[c.categoryName] = c.score;

  // Head pose from landmarks: nose (1), face edges (234 screen-left, 454 screen-right),
  // forehead (10), chin (152), outer eye corners (33 screen-left, 263 screen-right).
  const px = (i) => ({ x: lm[i].x * videoW, y: lm[i].y * videoH });
  const nose = px(1), left = px(234), right = px(454), top = px(10), chin = px(152);
  const eyeL = px(33), eyeR = px(263);
  const clamp = (v) => Math.max(-1, Math.min(1, v));

  return {
    // The person's left eye is on the right of the image.
    blinkL: s.eyeBlinkRight ?? 0,
    blinkR: s.eyeBlinkLeft ?? 0,
    lookX: clamp(((s.eyeLookOutLeft ?? 0) + (s.eyeLookInRight ?? 0) - (s.eyeLookInLeft ?? 0) - (s.eyeLookOutRight ?? 0)) / 2),
    lookY: clamp(((s.eyeLookDownLeft ?? 0) + (s.eyeLookDownRight ?? 0) - (s.eyeLookUpLeft ?? 0) - (s.eyeLookUpRight ?? 0)) / 2),
    jaw: s.jawOpen ?? 0,
    smileL: s.mouthSmileRight ?? 0,
    smileR: s.mouthSmileLeft ?? 0,
    frown: ((s.mouthFrownLeft ?? 0) + (s.mouthFrownRight ?? 0)) / 2,
    pucker: s.mouthPucker ?? 0,
    browUp: Math.max(s.browInnerUp ?? 0, ((s.browOuterUpLeft ?? 0) + (s.browOuterUpRight ?? 0)) / 2),
    // Relaxed brows often already score ~0.5 here, so only count clear frowns.
    browDown: Math.max(0, ((s.browDownLeft ?? 0) + (s.browDownRight ?? 0)) / 2 - 0.45) / 0.55,
    yaw: clamp(((nose.x - left.x) / Math.max(1, right.x - left.x) - 0.5) * 2.5),
    pitch: clamp(((nose.y - top.y) / Math.max(1, chin.y - top.y) - 0.55) * 4),
    roll: Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x),
  };
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
  const shown = { ...NEUTRAL_FACE };
  let target = { ...NEUTRAL_FACE };
  let lastSeen = 0, lastFrame = -1, running = true;

  const frame = () => {
    if (!running) return;
    const now = performance.now();
    if (video.readyState >= 2 && video.currentTime !== lastFrame) {
      lastFrame = video.currentTime;
      try {
        const face = readFace(tracker.detectForVideo(video, now), video.videoWidth, video.videoHeight);
        if (face) { target = face; lastSeen = now; }
      } catch (err) {
        console.warn('face tracking', err);
      }
    }
    const lost = now - lastSeen > 700;
    if (lost) {
      // Nobody in view: doze off and glance around.
      target = { ...NEUTRAL_FACE, blinkL: 0.65, blinkR: 0.65, lookX: Math.sin(now / 1500) * 0.6 };
    }
    for (const k in shown) {
      const speed = k.startsWith('blink') ? 0.7 : 0.45;
      shown[k] += (target[k] - shown[k]) * speed;
    }
    drawLegoHead(ctx, shown, hue);
    window.__avatar = { found: !lost, face: { ...shown } }; // for debugging and tests
    setTimeout(frame, 33); // timers (unlike requestAnimationFrame) keep running in a background tab
  };
  frame();

  return {
    kind: 'avatar',
    track,
    mirror: true,
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

  // Head, shaded on the side turned away
  const shade = ctx.createLinearGradient(-150, 0, 150, 0);
  const light = 0.5 - f.yaw * 0.35;
  shade.addColorStop(0, YELLOW_DARK);
  shade.addColorStop(Math.max(0.05, Math.min(0.95, light)), YELLOW);
  shade.addColorStop(1, YELLOW_DARK);
  ctx.fillStyle = shade;
  roundRect(ctx, -150, -150, 300, 290, 70);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0,0,0,.18)';
  ctx.stroke();

  // Face features move further than the head outline, which reads as the head turning.
  ctx.translate(f.yaw * 45, f.pitch * 28);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Cheeks
  const smile = (f.smileL + f.smileR) / 2;
  if (smile > 0.15) {
    ctx.fillStyle = `rgba(255, 110, 110, ${Math.min(0.45, smile * 0.5)})`;
    for (const x of [-98, 98]) {
      ctx.beginPath();
      ctx.ellipse(x, 42, 28, 16, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Eyes and eyebrows
  for (const [side, blink] of [[-1, f.blinkL], [1, f.blinkR]]) {
    const x = side * 55 + f.lookX * 9;
    const y = -22 + f.lookY * 7;
    const open = Math.max(0.08, 1 - blink * 1.1);
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.ellipse(x, y, 17, 23 * open, 0, 0, Math.PI * 2);
    ctx.fill();
    if (open > 0.35) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x - 5, y - 9 * open, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    const browY = -72 - f.browUp * 20 + f.browDown * 12;
    const innerDrop = f.browDown * 12 - f.browUp * 6; // frowning pulls the inner ends down
    ctx.strokeStyle = INK;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(side * 28, browY + innerDrop);
    ctx.quadraticCurveTo(side * 55, browY - 12, side * 80, browY + 4);
    ctx.stroke();
  }

  // Mouth
  const y = 58;
  const width = 96 * (1 - f.pucker * 0.55) + smile * 26;
  const lx = -width / 2, rx = width / 2;
  const ly = y - f.smileL * 24 + f.frown * 16;
  const ry = y - f.smileR * 24 + f.frown * 16;
  ctx.strokeStyle = INK;

  if (f.pucker > 0.55 && f.jaw < 0.2) {
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.ellipse(0, y + 4, 13, 16, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (f.jaw > 0.1) {
    const bottom = y + 16 + f.jaw * 110;
    const mouth = new Path2D();
    mouth.moveTo(lx, ly);
    mouth.quadraticCurveTo(0, y - 6 + smile * 12, rx, ry);
    mouth.quadraticCurveTo(0, bottom, lx, ly);
    mouth.closePath();
    ctx.fillStyle = '#4a0d12';
    ctx.fill(mouth);
    ctx.save();
    ctx.clip(mouth);
    if (smile > 0.3) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(lx, y - 30, width, 30 + 12);
    }
    ctx.fillStyle = '#e0626f';
    ctx.beginPath();
    ctx.ellipse(0, bottom - 8, width * 0.3, 18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 6;
    ctx.stroke(mouth);
  } else {
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.quadraticCurveTo(0, y + smile * 34 - f.frown * 22, rx, ry);
    ctx.stroke();
  }

  ctx.restore();
}

async function buildLook(kind, { name, picture }) {
  if (kind === 'camera') return cameraLook();
  if (kind === 'avatar') return avatarLook(name);
  if (kind === 'picture') return pictureLook(picture, name);
  return nameLook(name);
}
