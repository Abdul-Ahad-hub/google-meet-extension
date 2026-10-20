importScripts("config.js");

const OFFSCREEN_URL = "offscreen.html";
let recordingState = { recording: false, meetingId: null };

// ---------- Auth ----------

function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "No token returned."));
        return;
      }
      resolve(token);
    });
  });
}

async function fetchGoogleUserInfo(token) {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`userinfo request failed: ${res.status}`);
  return res.json(); // { email, name, picture, sub, ... }
}

async function handleLogin() {
  const token = await getAuthToken(true);
  const info = await fetchGoogleUserInfo(token);
  const user = { email: info.email, name: info.name, picture: info.picture, googleId: info.sub };
  await chrome.storage.local.set({ user, authToken: token });
  return user;
}

async function handleLogout() {
  const data = await chrome.storage.local.get(["authToken"]);
  if (data.authToken) {
    await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token: data.authToken }, resolve));
  }
  await chrome.storage.local.remove(["user", "authToken"]);
}

// ---------- Backend ----------

async function postJson(path, body) {
  let token = null;
  try {
    token = await getAuthToken(false); // silent; Google access token your backend can verify
  } catch (e) {
    /* send without it; backend decides whether that's acceptable */
  }
  const res = await fetch(CONFIG.BACKEND_BASE_URL + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Backend responded ${res.status} on ${path}`);
  return res;
}

// ---------- Offscreen document management ----------
// Camera + MediaPipe need a document context (the MV3 service worker has no
// DOM), so a hidden offscreen document does the capture.

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Sample the user's camera during an active Google Meet call and extract face landmarks.",
  });
}

async function closeOffscreenDocumentIfIdle() {
  if (recordingState.recording) return;
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

// ---------- Message router ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "AUTH_LOGIN": {
        try {
          const user = await handleLogin();
          sendResponse({ ok: true, user });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }

      case "AUTH_LOGOUT": {
        await handleLogout();
        sendResponse({ ok: true });
        break;
      }

      case "ENSURE_RECORDING": {
        // After Save, don't silently restart capture for the same meeting.
        const { stoppedMeetingId } = await chrome.storage.session.get(["stoppedMeetingId"]);
        if (message.meetingId && message.meetingId === stoppedMeetingId) {
          sendResponse({ ok: true, stopped: true });
          return;
        }
        // Idempotent: only (re)starts if not already capturing this meeting.
        if (recordingState.recording && recordingState.meetingId === message.meetingId) {
          sendResponse({ ok: true, already: true });
          return;
        }
        try {
          await ensureOffscreenDocument();
          const res = await chrome.runtime.sendMessage({
            type: "OFFSCREEN_START_RECORDING",
            meetingId: message.meetingId,
          });
          if (res && res.ok) {
            recordingState = { recording: true, meetingId: message.meetingId };
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: (res && res.error) || "Capture failed to start." });
          }
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }

      case "GET_RECORDING_STATE": {
        sendResponse(recordingState);
        break;
      }

      // One 10 s window (16 face crops + 16 landmark sets), sent up from the offscreen document.
      case "BATCH_READY": {
        try {
          const { user } = await chrome.storage.local.get(["user"]);
          await postJson(CONFIG.FRAMES_ENDPOINT, {
            ...message.batch,
            userEmail: (user && user.email) || null,
            userName: (user && user.name) || null,
            landmarkIndices: IMPORTANT_LANDMARKS,
            landmarkCount: IMPORTANT_LANDMARKS.length,
          });
          sendResponse({ ok: true });
        } catch (err) {
          console.warn("[background] batch upload failed:", err.message);
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }

      case "SAVE_SESSION": {
        console.log("[background] SAVE_SESSION received, stopping capture...");
        try {
          const stopRes = await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP_RECORDING" });
          console.log("[background] capture stop result:", stopRes);
          recordingState = { recording: false, meetingId: null };
          if (message.meetingId) {
            await chrome.storage.session.set({ stoppedMeetingId: message.meetingId });
          }
          await closeOffscreenDocumentIfIdle();

          if (!stopRes || !stopRes.ok) {
            sendResponse({ ok: false, error: (stopRes && stopRes.error) || "Stop failed with no details." });
            break;
          }

          const record = {
            userName: message.userName,
            userEmail: message.userEmail,
            meetingId: message.meetingId,
            role: message.role,
            savedAt: new Date().toISOString(),
            framesCaptured: stopRes.framesCaptured,
            framesWithFace: stopRes.framesWithFace,
            framesCenterCrop: stopRes.framesCenterCrop,
            avgFrameMs: stopRes.avgFrameMs,
            maxFrameMs: stopRes.maxFrameMs,
            windowsSent: stopRes.windowsSent,
            windowsUnsent: stopRes.windowsUnsent,
          };

          let sessionError = null;
          try {
            await postJson(CONFIG.SESSION_ENDPOINT, record);
          } catch (err) {
            sessionError = err.message;
            console.warn("[background] session post failed:", err.message);
          }

          const store = await chrome.storage.local.get(["sessions"]);
          const sessions = store.sessions || [];
          sessions.push({ ...record, sessionPosted: !sessionError });
          await chrome.storage.local.set({ sessions });
          console.log("[background] session record saved locally:", record);

          if (stopRes.windowsUnsent > 0 || sessionError) {
            const parts = [];
            if (stopRes.windowsUnsent > 0) {
              parts.push(`${stopRes.windowsUnsent} window(s) could not reach the backend (${stopRes.lastError || "unknown error"})`);
            }
            if (sessionError) parts.push(`session record not delivered (${sessionError})`);
            sendResponse({ ok: false, error: "Capture stopped, but " + parts.join("; ") + "." });
          } else {
            sendResponse({ ok: true, record });
          }
        } catch (err) {
          console.error("[background] SAVE_SESSION FAILED:", err.message);
          await closeOffscreenDocumentIfIdle();
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type." });
    }
  })();

  return true; // keep the message channel open for the async response
});
