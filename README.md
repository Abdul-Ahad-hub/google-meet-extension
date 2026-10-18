# Meet Session Recorder (landmark sampling build)

Captures the last frame of each second for 4 consecutive seconds, pauses 2 seconds, repeats.
Each frame is run through MediaPipe Face Mesh inside the extension; only the 52 landmarks in
`config.js` (IMPORTANT_LANDMARKS, same order as inference.py) are sent to the backend.
No video or images leave the browser.

Edit `config.js`: BACKEND_BASE_URL, FRAMES_ENDPOINT, SESSION_ENDPOINT, CAPTURE_SECONDS, GAP_SECONDS.

POST FRAMES_ENDPOINT (one per window of up to 4 frames):
{ meetingId, windowIndex, startedAt, partial, frames:[{second, capturedAt, faceDetected, landmarks:[[x,y,z] x52]|null}],
  userEmail, userName, landmarkIndices:[52 ints], landmarkCount:52 }

POST SESSION_ENDPOINT (on Save):
{ userName, userEmail, meetingId, role, savedAt, framesCaptured, framesWithFace, windowsSent, windowsUnsent }

Coordinates are MediaPipe normalized values (x,y in 0..1 of the frame, z relative depth).
vendor/face_mesh is @mediapipe/face_mesh from npm with one line patched (createNamedFunction no longer
uses `new Function`) so it runs under Chrome's Manifest V3 CSP.
