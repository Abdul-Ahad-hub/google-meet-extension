// Runs in the hidden offscreen document. Only chrome.runtime is available here
// (no storage, no downloads), so every network/storage action goes through
// background.js via messages.
//
// Pipeline: camera -> <video> -> once per second (4s on / 2s off) grab the
// current frame -> MediaPipe Face Mesh -> keep the 52 landmarks the model
// needs -> batch per window -> send to background -> backend.
// No video or image ever leaves this document; only landmark numbers do.

let stream = null;
let faceMesh = null;
let latestResults = null;

let running = false;
let timer = null;
let inFlight = null;
let startedAtMs = 0;
let tickNumber = 0;

let meetingId = null;
let windowIndex = 0;
let windowStartedAt = null;
let currentFrames = [];

let queue = [];
let flushPromise = null;
let lastError = null;
let stats = { framesCaptured: 0, framesWithFace: 0, windowsSent: 0, windowsDropped: 0 };

const video = document.getElementById("cam");

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

// Picks the 52 landmarks in the exact order of IMPORTANT_LANDMARKS (config.js).
function extractLandmarks(results) {
  const face = results && results.multiFaceLandmarks && results.multiFaceLandmarks[0];
  if (!face) return null;
  const out = [];
  for (const idx of IMPORTANT_LANDMARKS) {
    const p = face[idx];
    if (!p) return null;
    out.push([round6(p.x), round6(p.y), round6(p.z)]);
  }
  return out;
}

// ---------- Sampling scheduler ----------
// Every second tick; in each (CAPTURE + GAP)-second cycle, ticks 1..CAPTURE
// capture the frame that is current at that instant (the last frame of that
// second) and the remaining GAP ticks do nothing.

async function captureOne(secondInCycle) {
  const capturedAt = new Date().toISOString();
  let landmarks = null;
  try {
    if (video.readyState >= 2) {
      latestResults = null;
      await faceMesh.send({ image: video });
      landmarks = extractLandmarks(latestResults);
    } else {
      console.warn("[offscreen] video not ready, frame skipped");
    }
  } catch (err) {
    console.error("[offscreen] Face Mesh failed on a frame:", err && err.message);
  }

  if (currentFrames.length === 0) windowStartedAt = capturedAt;
  currentFrames.push({
    second: secondInCycle,
    capturedAt,
    faceDetected: !!landmarks,
    landmarks,
  });
  stats.framesCaptured += 1;
  if (landmarks) stats.framesWithFace += 1;
}

async function onTickWork(secondInCycle) {
  if (secondInCycle <= CONFIG.CAPTURE_SECONDS) {
    await captureOne(secondInCycle);
    if (secondInCycle === CONFIG.CAPTURE_SECONDS) finalizeWindow(false);
  }
}

function onTick() {
  if (!running) return;
  tickNumber += 1;
  const cycle = CONFIG.CAPTURE_SECONDS + CONFIG.GAP_SECONDS;
  const secondInCycle = ((tickNumber - 1) % cycle) + 1;
  scheduleNextTick(); // keep the 1 s cadence independent of processing time
  inFlight = onTickWork(secondInCycle);
}

function scheduleNextTick() {
  if (!running) return;
  const target = startedAtMs + (tickNumber + 1) * 1000;
  timer = setTimeout(onTick, Math.max(0, target - performance.now()));
}

// ---------- Batching + upload (via background) ----------

function finalizeWindow(partial) {
  if (currentFrames.length === 0) return;
  const batch = {
    meetingId,
    windowIndex: windowIndex++,
    startedAt: windowStartedAt,
    partial,
    frames: currentFrames,
  };
  currentFrames = [];
  windowStartedAt = null;

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
  windowStartedAt = null;
  currentFrames = [];
  queue = [];
  lastError = null;
  stats = { framesCaptured: 0, framesWithFace: 0, windowsSent: 0, windowsDropped: 0 };
  tickNumber = 0;
  startedAtMs = performance.now();
  running = true;
  scheduleNextTick();
  console.log("[offscreen] capture started (", CONFIG.CAPTURE_SECONDS, "s on /", CONFIG.GAP_SECONDS, "s off )");
  return { ok: true };
}

async function stopCapture() {
  if (!running) return { ok: false, error: "No active capture." };
  running = false;
  clearTimeout(timer);
  try {
    await inFlight;
  } catch (e) {
    /* ignore */
  }
  finalizeWindow(true); // send whatever partial window is pending
  releaseCamera();
  await flushQueue();
  if (queue.length > 0 && !lastError) await flushQueue();

  const result = {
    ok: true,
    framesCaptured: stats.framesCaptured,
    framesWithFace: stats.framesWithFace,
    windowsSent: stats.windowsSent,
    windowsUnsent: queue.length,
    windowsDropped: stats.windowsDropped,
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
