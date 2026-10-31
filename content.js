// Runs in the context of meet.google.com. Google Meet has no public DOM/API
// contract for this data, so everything below is a best-effort heuristic
// based on visible ARIA labels and text.

function getMeetingIdFromUrl() {
  const match = window.location.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})$/i);
  return match ? match[1] : null;
}

function isMeetingActive() {
  // A "Leave call" control only exists while you're actually in a call
  // (as opposed to the pre-join lobby screen or the Meet home screen).
  const leaveBtn = document.querySelector('[aria-label*="Leave call" i]');
  return !!leaveBtn;
}

function isCameraOn() {
  // Meet's camera toggle button flips its aria-label depending on state.
  const candidates = document.querySelectorAll('[aria-label*="camera" i]');
  for (const el of candidates) {
    const label = el.getAttribute("aria-label") || "";
    if (/turn off camera/i.test(label)) return true; // showing "turn off" means it's currently ON
    if (/turn on camera/i.test(label)) return false;
    const dataMuted = el.getAttribute("data-is-muted");
    if (dataMuted !== null) return dataMuted === "false";
  }
  return false; // unknown -> assume off, fail closed (don't capture without confirmation)
}

function detectRole() {
  // Heuristic only — Meet does not expose participant role via a documented API.
  const bodyText = document.body.innerText || "";
  if (/you're the meeting host|you are the meeting host/i.test(bodyText)) {
    return "admin";
  }
  const hostControl = document.querySelector('[aria-label*="Host controls" i]');
  if (hostControl) return "admin";
  return "participant";
}

function collectStatus() {
  return {
    meetingActive: isMeetingActive(),
    meetingId: getMeetingIdFromUrl(),
    cameraOn: isCameraOn(),
    role: detectRole(),
    url: window.location.href,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_MEET_STATUS") {
    sendResponse(collectStatus());
  }
  return false;
});

// Push state transitions (call joined/left, camera toggled) to background.js so
// capture can auto-start, pause when camera is off, and auto-save on call leave
// without requiring the user to keep the popup open.
let lastSignature = "";

function checkAndNotify() {
  if (!chrome.runtime?.id) return;
  const status = collectStatus();
  const sig = `${status.meetingActive}|${status.meetingId}|${status.cameraOn}|${status.role}`;
  if (sig === lastSignature) return;
  lastSignature = sig;
  chrome.runtime.sendMessage({ type: "MEET_STATUS_CHANGED", status }, () => {
    void chrome.runtime.lastError;
  });
}

setInterval(checkAndNotify, 2000);
checkAndNotify();
