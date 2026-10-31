importScripts("config.js");

const OFFSCREEN_URL = "offscreen.html";
let recordingState = {
  recording: false,
  paused: false,
  sessionId: null,
  meetingId: null,
  tabId: null,
  role: "participant",
};

// Restore state when the MV3 service worker wakes up.
chrome.storage.session.get(["recordingState"], (data) => {
  if (data && data.recordingState) {
    recordingState = { ...recordingState, ...data.recordingState };
  }
});

async function persistRecordingState(patch) {
  recordingState = { ...recordingState, ...patch };
  await chrome.storage.session.set({ recordingState });
  return recordingState;
}

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
  if (CONFIG.DEV_SKIP_LOGIN) {
    const user = { email: "dev@test.local", name: "Dev Tester", picture: null, googleId: "dev" };
    await chrome.storage.local.set({ user });
    return user;
  }

  const clientId = (chrome.runtime.getManifest().oauth2 || {}).client_id || "";
  if (!clientId || clientId.includes("PASTE_YOUR")) {
    throw new Error(
      "Google client_id is not set. Put your real OAuth client ID in manifest.json (oauth2.client_id), " +
        "then reload the extension. For testing only, set DEV_SKIP_LOGIN: true in config.js."
    );
  }

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

class HttpStatusError extends Error {
  constructor(status, path, detail) {
    super(`Backend responded ${status} on ${path}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    // 400/413/422 are permanent payload issues; retrying would stall the queue forever.
    this.permanent = status === 400 || status === 413 || status === 422;
  }
}

async function postJson(path, body) {
  let token = null;
  try {
    if (!CONFIG.DEV_SKIP_LOGIN) {
      token = await getAuthToken(false); // silent; Google access token your backend can verify
    }
  } catch (e) {
    /* send without it; backend decides whether that's acceptable */
  }

  const doFetch = (bearer) =>
    fetch(CONFIG.BACKEND_BASE_URL + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });

  let res = await doFetch(token);

  // If the cached Google token expired, evict it once and retry with a fresh token.
  if (res.status === 401 && token && !CONFIG.DEV_SKIP_LOGIN) {
    try {
      await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
      token = await getAuthToken(false);
      res = await doFetch(token);
    } catch (e) {
      /* keep the original 401 response */
    }
  }

  if (!res.ok) {
    let detail = "";
    try {
      const errBody = await res.json();
      detail = errBody.message
        ? Array.isArray(errBody.message)
          ? errBody.message.join("; ")
          : String(errBody.message)
        : JSON.stringify(errBody).slice(0, 200);
    } catch (e) {
      /* ignore non-JSON body */
    }
    throw new HttpStatusError(res.status, path, detail);
  }
  return res;
}

// ---------- Offscreen document management ----------
// Camera + MediaPipe need a document context (the MV3 service worker has no
// DOM), so a hidden offscreen document does the capture.

async function hasOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return existing.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Sample the user's camera during an active Google Meet call and extract face landmarks.",
  });
}

async function closeOffscreenDocumentIfIdle() {
  if (recordingState.recording) return;
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

async function syncStateWithOffscreen() {
  if (!(await hasOffscreenDocument())) {
    if (recordingState.recording) {
      await persistRecordingState({ recording: false, paused: false, sessionId: null, meetingId: null, tabId: null });
    }
    return recordingState;
  }
  try {
    const status = await chrome.runtime.sendMessage({ type: "OFFSCREEN_STATUS" });
    if (status && status.ok) {
      await persistRecordingState({
        recording: !!status.sessionActive,
        paused: !!status.paused,
        sessionId: status.sessionId || recordingState.sessionId,
        meetingId: status.meetingId || recordingState.meetingId,
      });
    }
  } catch (e) {
    /* ignore */
  }
  return recordingState;
}

// ---------- Start / Pause / Resume / Save helpers ----------

async function ensureRecording({ meetingId, role, tabId }) {
  await syncStateWithOffscreen();

  // After manual Save, don't silently restart capture for the same meeting.
  const { stoppedMeetingId } = await chrome.storage.session.get(["stoppedMeetingId"]);
  if (meetingId && meetingId === stoppedMeetingId) {
    return { ok: true, stopped: true };
  }

  // If already capturing this meeting: resume if paused, otherwise no-op.
  if (recordingState.recording && recordingState.meetingId === meetingId) {
    if (recordingState.paused) {
      const res = await chrome.runtime.sendMessage({ type: "OFFSCREEN_RESUME_RECORDING" });
      if (res && res.ok) {
        await persistRecordingState({ paused: false, role: role || recordingState.role, tabId: tabId ?? recordingState.tabId });
      }
      return res || { ok: false, error: "Resume failed." };
    }
    return { ok: true, already: true, sessionId: recordingState.sessionId };
  }

  await ensureOffscreenDocument();
  const res = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_START_RECORDING",
    meetingId,
  });
  if (res && res.ok) {
    await persistRecordingState({
      recording: true,
      paused: false,
      sessionId: res.sessionId,
      meetingId,
      role: role || "participant",
      tabId: tabId ?? null,
    });
    return { ok: true, sessionId: res.sessionId };
  }
  return { ok: false, error: (res && res.error) || "Capture failed to start." };
}

async function stopAndSaveSession({ meetingId, role, userName, userEmail, endReason, markStopped }) {
  console.log("[background] stopping capture & saving session...", { meetingId, endReason });
  try {
    if (!(await hasOffscreenDocument())) {
      await persistRecordingState({ recording: false, paused: false, sessionId: null, meetingId: null, tabId: null });
      return { ok: false, error: "No active capture." };
    }

    const stopRes = await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP_RECORDING" });
    console.log("[background] capture stop result:", stopRes);
    const activeMeetingId = meetingId || stopRes?.meetingId || recordingState.meetingId;
    const activeRole = role || recordingState.role || "participant";

    await persistRecordingState({ recording: false, paused: false, sessionId: null, meetingId: null, tabId: null });
    if (markStopped && activeMeetingId) {
      await chrome.storage.session.set({ stoppedMeetingId: activeMeetingId });
    }
    await closeOffscreenDocumentIfIdle();

    if (!stopRes || !stopRes.ok) {
      return { ok: false, error: (stopRes && stopRes.error) || "Stop failed with no details." };
    }

    const { user } = await chrome.storage.local.get(["user"]);
    const record = {
      sessionId: stopRes.sessionId || crypto.randomUUID(),
      userName: userName ?? (user && user.name) ?? null,
      userEmail: userEmail ?? (user && user.email) ?? null,
      userId: (user && user.googleId) || null,
      meetingId: activeMeetingId || null,
      role: activeRole,
      endReason: endReason || "user",
      startedAt: stopRes.startedAt || null,
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
      return { ok: false, error: "Capture stopped, but " + parts.join("; ") + ".", record };
    }
    return { ok: true, record };
  } catch (err) {
    console.error("[background] stopAndSaveSession FAILED:", err.message);
    await closeOffscreenDocumentIfIdle();
    return { ok: false, error: err.message };
  }
}

// If the Meet tab closes while a session is active, auto-save so buffered windows flush.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (CONFIG.AUTO_SAVE_ON_LEAVE && recordingState.recording && recordingState.tabId === tabId) {
    stopAndSaveSession({
      meetingId: recordingState.meetingId,
      role: recordingState.role,
      endReason: "tab-closed",
      markStopped: false,
    });
  }
});

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
        try {
          // If the user explicitly clicked Resume after Save, clear stoppedMeetingId first.
          if (message.clearStopped) {
            await chrome.storage.session.remove(["stoppedMeetingId"]);
          }
          const res = await ensureRecording({
            meetingId: message.meetingId,
            role: message.role,
            tabId: message.tabId ?? sender?.tab?.id ?? null,
          });
          sendResponse(res);
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }

      case "MEET_STATUS_CHANGED": {
        // Sent by content.js whenever meeting/camera state changes in the Meet tab.
        const status = message.status || {};
        const tabId = sender?.tab?.id ?? null;
        await syncStateWithOffscreen();

        let { user } = await chrome.storage.local.get(["user"]);
        if (!user && CONFIG.DEV_SKIP_LOGIN) {
          user = await handleLogin();
        }
        if (!user || !user.email) {
          sendResponse({ ok: true, ignored: "not-logged-in" });
          break;
        }

        if (status.meetingActive && status.cameraOn && CONFIG.AUTO_START) {
          const res = await ensureRecording({
            meetingId: status.meetingId,
            role: status.role,
            tabId,
          });
          sendResponse(res);
        } else if (recordingState.recording && status.meetingActive && !status.cameraOn && CONFIG.PAUSE_WHEN_CAMERA_OFF) {
          if (!recordingState.paused && (await hasOffscreenDocument())) {
            await chrome.runtime.sendMessage({ type: "OFFSCREEN_PAUSE_RECORDING" });
            await persistRecordingState({ paused: true });
          }
          sendResponse({ ok: true, paused: true });
        } else if (recordingState.recording && !status.meetingActive && CONFIG.AUTO_SAVE_ON_LEAVE) {
          const res = await stopAndSaveSession({
            meetingId: recordingState.meetingId,
            role: recordingState.role,
            endReason: "call-ended",
            markStopped: false,
          });
          sendResponse(res);
        } else {
          sendResponse({ ok: true });
        }
        break;
      }

      case "GET_RECORDING_STATE": {
        const state = await syncStateWithOffscreen();
        const { stoppedMeetingId } = await chrome.storage.session.get(["stoppedMeetingId"]);
        sendResponse({ ...state, stoppedMeetingId: stoppedMeetingId || null });
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
            userId: (user && user.googleId) || null,
            landmarkIndices: IMPORTANT_LANDMARKS,
            landmarkCount: IMPORTANT_LANDMARKS.length,
          });
          sendResponse({ ok: true });
        } catch (err) {
          console.warn("[background] batch upload failed:", err.message);
          sendResponse({ ok: false, drop: !!err.permanent, error: err.message });
        }
        break;
      }

      case "SAVE_SESSION": {
        const res = await stopAndSaveSession({
          meetingId: message.meetingId,
          role: message.role,
          userName: message.userName,
          userEmail: message.userEmail,
          endReason: "user",
          markStopped: true,
        });
        sendResponse(res);
        break;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type." });
    }
  })();

  return true; // keep the message channel open for the async response
});
