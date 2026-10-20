// Runs in the hidden offscreen document. Only chrome.runtime is available here
// (no storage, no downloads), so every network/storage action goes through
// background.js via messages.
//
// Pipeline (10 s capture, then BREAK_SECONDS rest, then repeat):
//   camera -> <video> -> every WINDOW_SECONDS / FRAMES_PER_WINDOW (625 ms) grab
//   the current frame -> MediaPipe Face Mesh on the FULL frame ->
//     * 52 landmarks (config.js IMPORTANT_LANDMARKS)
//     * face bounding box -> made square -> x CROP_SCALE (1.5) -> crop
//       -> resize to 160x160 -> RGB bytes
//     * NO face: centered square crop of the frame, landmarks all zeros
//   -> after 16 frames (10 s) stack everything into one window:
//        landmarks : [16][52][3]            (separate field)
//        frames    : uint8 [16,160,160,3]   (separate field, base64 of raw bytes)
//   -> send to background -> backend.

let stream = null;
let faceMesh = null;
let latestResults = null;

let running = false;
let timer = null;
let processing = Promise.resolve(); // serial chain: frames are processed in order
let startedAtMs = 0;
let nextTick = 0; // index of the next frame to capture (0-based, counts capture frames only)

let meetingId = null;
let windowIndex = 0;
let win = null; // the window currently being filled

let queue = [];
let flushPromise = null;
let lastError = null;
let stats = newStats();

function newStats() {
  return {
    framesCaptured: 0, framesWithFace: 0, framesCenterCrop: 0,
    windowsSent: 0, windowsDropped: 0, partialDropped: 0,
    frameMsSum: 0, frameMsMax: 0, meshMsSum: 0, slowFrames: 0,
  };
}

const video = document.getElementById("cam");

const N = CONFIG.FRAMES_PER_WINDOW;
const S = CONFIG.OUTPUT_SIZE;
const FRAME_BYTES = S * S * 3;
const FRAME_INTERVAL_MS = (CONFIG.WINDOW_SECONDS * 1000) / N;
const CYCLE_MS = (CONFIG.WINDOW_SECONDS + CONFIG.BREAK_SECONDS) * 1000;

// Reused canvas for the 160x160 crop.
const cropCanvas = document.createElement("canvas");
cropCanvas.width = S;
cropCanvas.height = S;
const cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true });

// ---------- Face Mesh ----------

async function ensureFaceMesh() {
  if (faceMesh) return;
  console.log("[offscreen] initialising Face Mesh...");
  const fm = new FaceMesh({
    locateFile: (file) => chrome.runtime.getURL("vendor/face_mesh/" + file),
  });
  fm.setOptions({
    maxNumFaces: 1,
    refineLandmarks: false, // 468-point mesh, same as the default Python FaceMesh
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  fm.onResults((results) => {
    latestResults = results;
  });
  await fm.initialize();
  faceMesh = fm;
  console.log("[offscreen] Face Mesh ready");
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const round1 = (n) => Math.round(n * 10) / 10;

// Picks the 52 landmarks in the exact order of IMPORTANT_LANDMARKS (config.js).
// Coordinates are normalised to the FULL (uncropped) frame.
function pickLandmarks(face) {
  const out = [];
  for (const idx of IMPORTANT_LANDMARKS) {
    const p = face[idx];
    if (!p) return null;
    out.push([round6(p.x), round6(p.y), round6(p.z)]);
  }
  return out;
}

// Face bounding box from all 468 mesh points -> square -> scaled by CROP_SCALE,
// so the crop contains the face plus some head/shoulder area around it.
// Returned in source-frame pixels; x/y may be negative (box sticks out of frame).
function faceCropBox(face, frameW, frameH) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of face) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const cx = ((minX + maxX) / 2) * frameW;
  const cy = ((minY + maxY) / 2) * frameH;
  const side = Math.max((maxX - minX) * frameW, (maxY - minY) * frameH) * CONFIG.CROP_SCALE;
  return { x: cx - side / 2, y: cy - side / 2, size: side };
}

// No face found: biggest centered square of the frame (no extra scaling).
function centerCropBox(frameW, frameH) {
  const side = Math.min(frameW, frameH);
  return { x: (frameW - side) / 2, y: (frameH - side) / 2, size: side };
}

// Draws the crop into the 160x160 canvas (black where the box leaves the frame)
// and writes the RGB bytes (alpha dropped) into `out` starting at `offset`.
function cropToRgb(snap, box, out, offset) {
  cropCtx.fillStyle = "#000";
  cropCtx.fillRect(0, 0, S, S);

  const sx0 = Math.max(0, box.x);
  const sy0 = Math.max(0, box.y);
  const sx1 = Math.min(snap.width, box.x + box.size);
  const sy1 = Math.min(snap.height, box.y + box.size);
  if (sx1 <= sx0 || sy1 <= sy0) return false;

  const k = S / box.size;
  cropCtx.imageSmoothingEnabled = true;
  cropCtx.imageSmoothingQuality = "high";
  cropCtx.drawImage(snap, sx0, sy0, sx1 - sx0, sy1 - sy0, (sx0 - box.x) * k, (sy0 - box.y) * k, (sx1 - sx0) * k, (sy1 - sy0) * k);

  const rgba = cropCtx.getImageData(0, 0, S, S).data;
  let j = offset;
  for (let i = 0; i < rgba.length; i += 4) {
    out[j++] = rgba[i];
    out[j++] = rgba[i + 1];
    out[j++] = rgba[i + 2];
  }
  return true;
}

// ---------- Window buffer ----------

const zeroLandmarks = () => Array.from({ length: IMPORTANT_LANDMARKS.length }, () => [0, 0, 0]);

function newWindow() {
  return {
    startedAt: null,
    count: 0, // frames processed so far in this window
    pixels: new Uint8Array(N * FRAME_BYTES), // zero-filled = "no face" frames stay black
    landmarks: Array.from({ length: N }, zeroLandmarks),
    faceDetected: new Array(N).fill(false),
    capturedAt: new Array(N).fill(null),
    cropBoxes: new Array(N).fill(null),
    frameTimingsMs: new Array(N).fill(null),
  };
}

// ---------- Sampling scheduler ----------
// One frame every FRAME_INTERVAL_MS for 16 frames, then BREAK_SECONDS of silence. The video frame is
// snapshotted the instant the tick fires; the (slower) Face Mesh work then runs
// in order on a promise chain so ticks never drift.

function snapshotVideo() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (video.readyState < 2 || !w || !h) return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(video, 0, 0, w, h);
  return c;
}

async function processFrame(slot, snap, capturedAt) {
  const t0 = performance.now();
  let face = null;
  let landmarks = null;
  let box = null;
  let source = null; // "face" | "center" | null (no usable image at all)
  let cropped = false;
  let meshMs = 0;
  let cropMs = 0;

  // 1) face detection + landmarks on the full frame
  if (snap) {
    try {
      latestResults = null;
      const tMesh = performance.now();
      await faceMesh.send({ image: snap });
      meshMs = performance.now() - tMesh;
      face = latestResults && latestResults.multiFaceLandmarks && latestResults.multiFaceLandmarks[0];
      if (face) landmarks = pickLandmarks(face);
    } catch (err) {
      console.error("[offscreen] Face Mesh failed on a frame:", err && err.message);
    }
  } else {
    console.warn("[offscreen] video not ready, frame skipped");
  }

  // 2) crop: face box x CROP_SCALE, or centered square when no face
  if (snap) {
    const tCrop = performance.now();
    try {
      if (landmarks) {
        box = faceCropBox(face, snap.width, snap.height);
        source = "face";
      } else {
        box = centerCropBox(snap.width, snap.height);
        source = "center";
      }
      cropped = cropToRgb(snap, box, win.pixels, slot * FRAME_BYTES);
    } catch (err) {
      console.error("[offscreen] crop failed:", err && err.message);
      cropped = false;
    }
    cropMs = performance.now() - tCrop;
  }

  // 3) store into the window (landmarks stay all-zero when no face)
  if (win.count === 0) win.startedAt = capturedAt;
  win.capturedAt[slot] = capturedAt;
  if (landmarks && cropped) {
    win.faceDetected[slot] = true;
    win.landmarks[slot] = landmarks;
    stats.framesWithFace += 1;
  } else if (cropped) {
    stats.framesCenterCrop += 1;
  }
  if (cropped) {
    win.cropBoxes[slot] = {
      source,
      x: Math.round(box.x),
      y: Math.round(box.y),
      size: Math.round(box.size),
      frameWidth: snap.width,
      frameHeight: snap.height,
    };
  } else {
    win.pixels.fill(0, slot * FRAME_BYTES, (slot + 1) * FRAME_BYTES);
  }

  // 4) timing for this frame (snapshot already taken, so this is pure processing cost)
  const totalMs = performance.now() - t0;
  win.frameTimingsMs[slot] = { meshMs: round1(meshMs), cropMs: round1(cropMs), totalMs: round1(totalMs) };
  stats.frameMsSum += totalMs;
  stats.frameMsMax = Math.max(stats.frameMsMax, totalMs);
  stats.meshMsSum += meshMs;
  if (totalMs > FRAME_INTERVAL_MS) {
    stats.slowFrames += 1;
    console.warn(`[offscreen] frame took ${totalMs.toFixed(0)} ms, longer than the ${FRAME_INTERVAL_MS} ms interval`);
  }
  stats.framesCaptured += 1;
  win.count += 1;

  if (slot === N - 1) await finalizeWindow(false);
}

function onTick() {
  if (!running) return;
  const slot = nextTick % N;
  nextTick += 1;
  scheduleNextTick(); // keep the cadence independent of processing time

  const snap = snapshotVideo();
  const capturedAt = new Date().toISOString();
  processing = processing.then(() => processFrame(slot, snap, capturedAt)).catch((e) => console.error("[offscreen]", e));
}

function scheduleNextTick() {
  if (!running) return;
  // Frame k of window w fires at  start + w * (10 s on + BREAK s off) + k * 625 ms.
  const windowNo = Math.floor(nextTick / N);
  const slot = nextTick % N;
  const target = startedAtMs + windowNo * CYCLE_MS + slot * FRAME_INTERVAL_MS;
  timer = setTimeout(onTick, Math.max(0, target - performance.now()));
}

// ---------- Batching + upload (via background) ----------

function bytesToBase64(bytes) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(new Blob([bytes]));
  });
}

async function finalizeWindow(partial) {
  const w = win;
  if (!w || w.count === 0) return;
  win = newWindow();

  const index = windowIndex++;
  const tEnc = performance.now();
  const data = await bytesToBase64(w.pixels);
  const encodeMs = performance.now() - tEnc;
  const done = w.frameTimingsMs.filter(Boolean);
  const sum = (k) => done.reduce((acc, t) => acc + t[k], 0);
  const timing = {
    avgFrameMs: round1(sum("totalMs") / Math.max(1, done.length)),
    maxFrameMs: round1(Math.max(0, ...done.map((t) => t.totalMs))),
    avgMeshMs: round1(sum("meshMs") / Math.max(1, done.length)),
    encodeMs: round1(encodeMs),
    windowSpanMs: Date.now() - Date.parse(w.startedAt), // first frame -> window finished
  };
  console.log(`[offscreen] window ${index} done:`, timing);
  const batch = {
    meetingId,
    windowIndex: index,
    startedAt: w.startedAt,
    endedAt: new Date().toISOString(),
    partial,
    framesFilled: w.count,
    frameIntervalMs: FRAME_INTERVAL_MS,
    faceDetected: w.faceDetected, // [16] booleans; false = that slot is all zeros
    capturedAt: w.capturedAt, // [16] ISO timestamps
    cropBoxes: w.cropBoxes, // [16] crop used per frame; source = "face" or "center"
    frameTimingsMs: w.frameTimingsMs, // [16] { meshMs, cropMs, totalMs } processing time per frame
    timing, // per-window summary

    // --- landmarks: their own field -------------------------------------
    landmarks: w.landmarks, // [16][52][3], normalised to the full frame

    // --- frames: their own field ----------------------------------------
    frames: {
      encoding: "base64",
      dtype: "uint8",
      shape: [N, S, S, 3],
      channelOrder: "RGB",
      data, // base64 of N*S*S*3 raw bytes, row-major
    },
  };

  queue.push(batch);
  while (queue.length > CONFIG.MAX_QUEUED_WINDOWS) {
    queue.shift();
    stats.windowsDropped += 1;
  }
  flushQueue();
}

function flushQueue() {
  if (flushPromise) return flushPromise;
  flushPromise = (async () => {
    try {
      while (queue.length > 0) {
        const batch = queue[0];
        let res;
        try {
          res = await chrome.runtime.sendMessage({ type: "BATCH_READY", batch });
        } catch (err) {
          res = { ok: false, error: err.message };
        }
        if (res && res.ok) {
          queue.shift();
          stats.windowsSent += 1;
          lastError = null;
        } else {
          lastError = (res && res.error) || "No response from background.";
          console.warn("[offscreen] batch upload failed, will retry:", lastError);
          break;
        }
      }
    } finally {
      flushPromise = null;
    }
    if (queue.length > 0 && !lastError) flushQueue();
  })();
  return flushPromise;
}

// ---------- Start / stop ----------

function releaseCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
}

async function startCapture(newMeetingId) {
  if (running) return { ok: true, already: true };

  console.log("[offscreen] requesting camera...");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (err) {
    console.error("[offscreen] getUserMedia FAILED:", err.name, err.message);
    return { ok: false, error: `${err.name}: ${err.message}` };
  }

  try {
    video.srcObject = stream;
    await video.play();
    await ensureFaceMesh();
  } catch (err) {
    console.error("[offscreen] setup FAILED:", err && err.message);
    releaseCamera();
    return { ok: false, error: `Setup failed: ${err && err.message}` };
  }

  meetingId = newMeetingId;
  windowIndex = 0;
  win = newWindow();
  queue = [];
  lastError = null;
  stats = newStats();
  processing = Promise.resolve();
  nextTick = 0;
  startedAtMs = performance.now();
  running = true;
  scheduleNextTick();
  console.log("[offscreen] capture started:", N, "frames /", CONFIG.WINDOW_SECONDS, "s, then", CONFIG.BREAK_SECONDS, "s break, crop x" + CONFIG.CROP_SCALE, "->", S + "x" + S + "x3");
  return { ok: true };
}

async function stopCapture() {
  if (!running) return { ok: false, error: "No active capture." };
  running = false;
  clearTimeout(timer);
  try {
    await processing; // let queued frames finish
  } catch (e) {
    /* ignore */
  }

  if (win && win.count > 0) {
    if (CONFIG.SEND_PARTIAL_WINDOW) await finalizeWindow(true);
    else stats.partialDropped += 1;
  }
  win = null;

  releaseCamera();
  await flushQueue();
  if (queue.length > 0 && !lastError) await flushQueue();

  const result = {
    ok: true,
    framesCaptured: stats.framesCaptured,
    framesWithFace: stats.framesWithFace,
    framesCenterCrop: stats.framesCenterCrop,
    avgFrameMs: round1(stats.frameMsSum / Math.max(1, stats.framesCaptured)),
    maxFrameMs: round1(stats.frameMsMax),
    slowFrames: stats.slowFrames,
    windowsSent: stats.windowsSent,
    windowsUnsent: queue.length,
    windowsDropped: stats.windowsDropped,
    partialDropped: stats.partialDropped,
    lastError,
  };
  console.log("[offscreen] capture stopped:", result);
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "OFFSCREEN_START_RECORDING") {
    startCapture(message.meetingId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === "OFFSCREEN_STOP_RECORDING") {
    stopCapture()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});
