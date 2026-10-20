// Edit these to match your NestJS backend. Loaded by background.js (importScripts)
// and offscreen.html (<script>), so keep it as plain top-level constants.

const CONFIG = {
  // TESTING ONLY: skip Google sign-in and use a fake user, so you can test the
  // capture pipeline before the OAuth client ID is set up. Keep false in production.
  DEV_SKIP_LOGIN: false,

  // Base URL of your backend. Use your deployed https URL in production.
  BACKEND_BASE_URL: "http://localhost:3000",

  // One POST per window (16 frames + 16 landmark sets). Align with your controller routes.
  FRAMES_ENDPOINT: "/engagement/frames",

  // One POST when the user clicks Save (session metadata + role).
  SESSION_ENDPOINT: "/engagement/sessions",

  // Sampling pattern: capture for WINDOW_SECONDS (FRAMES_PER_WINDOW frames, evenly
  // spaced: 10 s / 16 = one frame every 625 ms), then rest for BREAK_SECONDS,
  // then start the next window. Cycle = 10 s on + 20 s off = 30 s by default.
  WINDOW_SECONDS: 10,
  FRAMES_PER_WINDOW: 16,
  BREAK_SECONDS: 20,

  // Face crop: the face bounding box (from Face Mesh) is made square and scaled
  // by this factor so some shoulders/body come along with the face.
  CROP_SCALE: 1.5,

  // When NO face is found in a frame, that frame is still kept: the biggest
  // centered square of the camera image is used instead (landmarks = all zeros).

  // Every cropped frame is resized to OUTPUT_SIZE x OUTPUT_SIZE x 3 (RGB, uint8).
  OUTPUT_SIZE: 160,

  // If the user clicks Save in the middle of a window, send the incomplete
  // window (missing frames zero-filled) or throw it away.
  SEND_PARTIAL_WINDOW: false,

  // Max unsent windows kept in memory if the backend is unreachable.
  // One window is ~1.6 MB as base64, so keep this small.
  MAX_QUEUED_WINDOWS: 6,
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
