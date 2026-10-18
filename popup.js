const viewAuth = document.getElementById("view-auth");
const viewMain = document.getElementById("view-main");

const elUserName = document.getElementById("user-name");
const elUserEmail = document.getElementById("user-email");
const elMeeting = document.getElementById("status-meeting");
const elMeetingId = document.getElementById("status-meeting-id");
const elRole = document.getElementById("status-role");
const elCamera = document.getElementById("status-camera");
const elRecording = document.getElementById("status-recording");
const elError = document.getElementById("error-box");
const elSaveHint = document.getElementById("save-hint");
const btnSave = document.getElementById("btn-save");
const btnEnableCamera = document.getElementById("btn-enable-camera");

let pollTimer = null;
let currentTabId = null;
let lastKnownStatus = null;

function showError(msg) {
  elError.textContent = msg;
  elError.classList.remove("hidden");
}

function clearError() {
  elError.classList.add("hidden");
  elError.textContent = "";
}

function switchToMain(user) {
  viewAuth.classList.add("hidden");
  viewMain.classList.remove("hidden");
  elUserName.textContent = user.name || "Signed in";
  elUserEmail.textContent = user.email || "";
  checkCameraPermission();
  startPolling();
}

// ---------- Camera permission ----------
// Chrome can't show a getUserMedia prompt inside the hidden offscreen
// document, so permission has to be granted from a real tab (the options
// page) instead. This just checks state and links out to that page.

async function checkCameraPermission() {
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const status = await navigator.permissions.query({ name: "camera" });
      btnEnableCamera.classList.toggle("hidden", status.state === "granted");
      return;
    }
  } catch (e) {
    // Permissions API for "camera" isn't supported in every context; fall
    // back to the stored flag below.
  }
  const data = await chrome.storage.local.get(["cameraGranted"]);
  btnEnableCamera.classList.toggle("hidden", !!data.cameraGranted);
}

btnEnableCamera.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// Re-check permission whenever the popup regains focus (e.g. after the user
// comes back from the options tab where they granted access).
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) checkCameraPermission();
});

function switchToAuth() {
  stopPolling();
  viewMain.classList.add("hidden");
  viewAuth.classList.remove("hidden");
}

// ---------- Auth ----------

async function login() {
  clearError();
  chrome.runtime.sendMessage({ type: "AUTH_LOGIN" }, (response) => {
    if (chrome.runtime.lastError) {
      showError(chrome.runtime.lastError.message);
      return;
    }
    if (!response || !response.ok) {
      showError((response && response.error) || "Sign-in failed.");
      return;
    }
    switchToMain(response.user);
  });
}

function logout() {
  chrome.runtime.sendMessage({ type: "AUTH_LOGOUT" }, () => {
    switchToAuth();
  });
}

document.getElementById("btn-login").addEventListener("click", login);
document.getElementById("btn-signup").addEventListener("click", login); // same OAuth flow; Google handles new vs existing account
document.getElementById("btn-logout").addEventListener("click", logout);

// ---------- Live status polling against the active Meet tab ----------

async function getActiveMeetTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (tab && tab.url && tab.url.startsWith("https://meet.google.com/")) {
    return tab;
  }
  return null;
}

function requestStatus(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "GET_MEET_STATUS" }, (status) => {
    if (chrome.runtime.lastError || !status) {
      renderNoMeeting();
      return;
    }
    renderStatus(status);
  });
}

function renderNoMeeting() {
  elMeeting.textContent = "Not detected";
  elMeeting.className = "status-value muted";
  elMeetingId.textContent = "—";
  elRole.textContent = "—";
  elCamera.textContent = "Off";
  elCamera.className = "status-value muted";
  btnSave.disabled = true;
  elSaveHint.textContent = "Open an active Meet call with your camera on to start capture.";
  lastKnownStatus = null;
}

function renderStatus(status) {
  lastKnownStatus = status;

  elMeeting.textContent = status.meetingActive ? "In progress" : "Not active";
  elMeeting.className = status.meetingActive ? "status-value ok" : "status-value muted";

  elMeetingId.textContent = status.meetingId || "—";
  elRole.textContent = status.role || "Unknown";

  elCamera.textContent = status.cameraOn ? "On" : "Off";
  elCamera.className = status.cameraOn ? "status-value ok" : "status-value muted";

  chrome.runtime.sendMessage({ type: "GET_RECORDING_STATE" }, (rec) => {
    const isRecording = rec && rec.recording;
    elRecording.textContent = isRecording ? "Capturing…" : "Idle";
    elRecording.className = isRecording ? "status-value ok" : "status-value muted";
  });

  const canRecord = status.meetingActive && status.cameraOn;
  btnSave.disabled = !canRecord;
  elSaveHint.textContent = canRecord
    ? "Sampling your camera (4 s on / 2 s off). Click Save to stop and send this session."
    : "Camera must be on and the meeting must be active to capture.";

  // Ask background to (idempotently) start capture once conditions are met.
  if (canRecord) {
    chrome.runtime.sendMessage(
      { type: "ENSURE_RECORDING", meetingId: status.meetingId },
      (res) => {
        if (chrome.runtime.lastError) return;
        if (res && !res.ok && res.error) {
          showError(res.error);
        } else if (res && res.ok) {
          clearError();
        }
      }
    );
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    const tab = await getActiveMeetTab();
    if (!tab) {
      renderNoMeeting();
      return;
    }
    currentTabId = tab.id;
    requestStatus(tab.id);
  }, 1200);

  // fire immediately too
  getActiveMeetTab().then((tab) => {
    if (tab) {
      currentTabId = tab.id;
      requestStatus(tab.id);
    } else {
      renderNoMeeting();
    }
  });
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ---------- Save ----------

btnSave.addEventListener("click", async () => {
  clearError();
  btnSave.disabled = true;
  btnSave.textContent = "Saving…";

  chrome.storage.local.get(["user"], (data) => {
    const user = data.user || {};
    const payload = {
      type: "SAVE_SESSION",
      meetingId: (lastKnownStatus && lastKnownStatus.meetingId) || null,
      role: (lastKnownStatus && lastKnownStatus.role) || "unknown",
      userName: user.name || null,
      userEmail: user.email || null,
    };

    chrome.runtime.sendMessage(payload, (response) => {
      btnSave.textContent = "Save";
      if (!response || !response.ok) {
        showError((response && response.error) || "Save failed.");
        btnSave.disabled = false;
        return;
      }
      elRecording.textContent = "Saved";
      elRecording.className = "status-value ok";
    });
  });
});

// ---------- Init ----------

chrome.storage.local.get(["user"], (data) => {
  if (data.user && data.user.email) {
    switchToMain(data.user);
  } else {
    switchToAuth();
  }
});
