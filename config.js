// Edit these to match your NestJS backend. Loaded by background.js (importScripts)
// and offscreen.html (<script>), so keep it as plain top-level constants.

const CONFIG = {
  // Base URL of your backend. Use your deployed https URL in production.
  BACKEND_BASE_URL: "http://localhost:3000",

  // One POST per sampling window (4 landmark frames). Align with your controller routes.
  FRAMES_ENDPOINT: "/engagement/frames",

  // One POST when the user clicks Save (session metadata + role).
  SESSION_ENDPOINT: "/engagement/sessions",

  // Sampling pattern: capture the last frame of each second for CAPTURE_SECONDS
  // seconds, then pause for GAP_SECONDS seconds, then repeat.
  CAPTURE_SECONDS: 4,
  GAP_SECONDS: 2,

  // Max unsent windows kept in memory if the backend is unreachable.
  MAX_QUEUED_WINDOWS: 100,
};

// The exact 52 landmark indices, in the exact order of inference.py's
// IMPORTANT_LANDMARKS. Note _JAW repeats 454 three times on purpose, to match.
const LANDMARK_GROUPS = {
  left_eye: [33, 133, 159, 145, 153, 154, 155, 160, 161],
  right_eye: [362, 263, 386, 374, 380, 381, 382, 387, 388],
  mouth: [13, 14, 78, 308, 61, 291, 81, 82, 87, 312],
  nose: [1, 2, 98, 327, 168],
  jaw: [152, 13, 14, 234, 454, 454, 454],
  left_brow: [70, 63, 105, 66, 107, 55],
  right_brow: [336, 296, 334, 293, 300, 283],
};

const IMPORTANT_LANDMARKS = [
  ...LANDMARK_GROUPS.left_eye,
  ...LANDMARK_GROUPS.right_eye,
  ...LANDMARK_GROUPS.mouth,
  ...LANDMARK_GROUPS.nose,
  ...LANDMARK_GROUPS.jaw,
  ...LANDMARK_GROUPS.left_brow,
  ...LANDMARK_GROUPS.right_brow,
];
