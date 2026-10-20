# Meet Session Recorder

A Chrome extension (Manifest V3) that watches the user's camera during a Google Meet call, finds the
face with MediaPipe Face Mesh, and sends the backend two things every cycle:

- **16 face-crop images** (160 x 160 x 3), and
- **16 sets of 52 face landmarks**,

as separate fields of one request. **No video is uploaded, no audio is recorded.** Only these small
cropped frames and landmark numbers leave the browser.

---

## 1. What happens over time

One cycle = **10 s capture + 20 s break = 30 s**. The cycle repeats until the user clicks **Save**.

```
time (s) :  0         10                         30        40                         60
            |---------|--------------------------|---------|--------------------------|
            [capture ]  break (nothing happens)  [capture ]  break (nothing happens)
             16 frames        20 s                16 frames        20 s
             window #0                            window #1
```

Inside the 10 s capture part, the 16 frames are evenly spaced: **one frame every 625 ms**
(10 s / 16). Frame 0 is taken at 0 ms, frame 1 at 625 ms, ... frame 15 at 9375 ms.

When the 16th frame has been processed, the window is stacked, encoded and posted to the backend
while the 20 s break is running. The break length is measured from the window start, so the next
window always starts exactly 30 s after the previous one (the timer does not drift, even if a frame
is slow to process).

If the user clicks **Save** in the middle of a window, that unfinished window is thrown away by
default (see `SEND_PARTIAL_WINDOW`). Clicking Save during a break loses nothing.

---

## 2. What happens to each frame

```
camera frame (full, e.g. 640x480)
   |
   |-- MediaPipe Face Mesh (468 points) --+-- face found? ----YES---> face bounding box
   |                                      |                            -> made square
   |                                      |                            -> scaled x1.5  (CROP_SCALE)
   |                                      |                            -> crop
   |                                      |                            landmarks = the 52 chosen points
   |                                      |
   |                                      +-- face found? ----NO----> biggest centered square of the frame
   |                                                                   landmarks = 52 x [0,0,0]
   v
crop  ->  resize to 160 x 160  ->  RGB bytes (alpha dropped)  ->  slot k of the 16-frame stack
```

1. **Face detection.** Face Mesh runs on the *full* frame. The bounding box of all 468 mesh points is
   the detected face box.
2. **1.5x scale.** The box is made square (longest side) and enlarged 1.5 times around its center, so
   the crop contains the face plus some hair, neck and shoulders. If the enlarged box sticks out of
   the camera image, the missing part is filled with black.
3. **Landmarks.** The 52 points listed in `config.js` (`IMPORTANT_LANDMARKS`, same order as
   `inference.py`) are taken from the **same full frame**. Their x/y values are normalized to the
   full frame (0..1), **not** to the crop. `cropBoxes` in the payload lets the backend convert them
   if it ever needs crop-relative coordinates.
4. **Resize + RGB.** The crop is resized to 160 x 160 and stored as raw `uint8` RGB bytes.

### When no face is detected

The frame is **not** skipped and not black. Instead:

| Part | Value |
|------|-------|
| image | center crop: the biggest centered square of the camera image, resized to 160 x 160 |
| landmarks | `52 x [0, 0, 0]` |
| `faceDetected[k]` | `false` |
| `cropBoxes[k].source` | `"center"` (instead of `"face"`) |

So the tensors always keep the shape `[16, ...]`, and the backend can tell real landmarks from
filler with `faceDetected`. Only if the camera itself is not ready (no image at all) does a slot stay
all-zero, with `cropBoxes[k] = null`.

---

## 3. Timing: how long does each frame take?

Every frame measures its own processing time (from the moment the snapshot is handed to Face Mesh
until the 160x160 crop is written):

- `meshMs`  - Face Mesh detection + landmarks
- `cropMs`  - crop, resize and RGB conversion
- `totalMs` - the whole frame

You can see this in three places:

1. **Browser console** (open `chrome://extensions` -> *Inspect views: offscreen.html*). One line per
   finished window, e.g. `window 3 done: { avgFrameMs, maxFrameMs, avgMeshMs, encodeMs, windowSpanMs }`.
   A warning is printed if a single frame takes longer than the 625 ms interval.
2. **The window payload** sent to the backend: `frameTimingsMs` (16 entries) and `timing` (summary).
3. **The session record** posted on Save: `avgFrameMs`, `maxFrameMs`.

`windowSpanMs` is the time from the first captured frame of a window until the window is finished
(about 9.4 s of capture plus the last frame's processing). `encodeMs` is the time spent turning the
1.2 MB of pixels into base64.

If `avgFrameMs` gets close to 625 ms the computer cannot keep up; frames still go out in order, but
you should lower `OUTPUT_SIZE` or `FRAMES_PER_WINDOW`.

---

## 4. Request sent to the backend

`POST {BACKEND_BASE_URL}{FRAMES_ENDPOINT}` - one per window (about 1.6 MB of JSON).

```jsonc
{
  "meetingId": "abc-defg-hij",
  "windowIndex": 0,                 // 0, 1, 2 ... counts finished windows of this recording
  "startedAt": "2026-10-21T10:00:00.000Z",
  "endedAt":   "2026-10-21T10:00:09.800Z",
  "partial": false,
  "framesFilled": 16,
  "frameIntervalMs": 625,

  "faceDetected": [true, true, false, ...],        // 16 booleans
  "capturedAt":   ["2026-10-21T10:00:00.002Z", ...], // 16 timestamps
  "cropBoxes": [                                   // 16 entries, crop used in full-frame pixels
    { "source": "face",   "x": 190, "y": 60, "size": 260, "frameWidth": 640, "frameHeight": 480 },
    { "source": "center", "x": 80,  "y": 0,  "size": 480, "frameWidth": 640, "frameHeight": 480 }
  ],
  "frameTimingsMs": [ { "meshMs": 31.4, "cropMs": 2.1, "totalMs": 34.0 }, ... ],   // 16 entries
  "timing": { "avgFrameMs": 35.2, "maxFrameMs": 61.5, "avgMeshMs": 32.0, "encodeMs": 18.3, "windowSpanMs": 9420 },

  "landmarks": [ [[x,y,z], ... 52 points], ... 16 frames ],   // shape [16, 52, 3]   <- separate field

  "frames": {                                                 // <- separate field
    "encoding": "base64",
    "dtype": "uint8",
    "shape": [16, 160, 160, 3],
    "channelOrder": "RGB",
    "data": "<base64 of 16*160*160*3 = 1,228,800 raw bytes>"
  },

  "userEmail": "...", "userName": "...",
  "landmarkIndices": [ ...52 ints... ], "landmarkCount": 52
}
```

`POST {BACKEND_BASE_URL}{SESSION_ENDPOINT}` - once, when the user clicks Save:

```json
{ "userName": "...", "userEmail": "...", "meetingId": "...", "role": "admin|participant",
  "savedAt": "...", "framesCaptured": 96, "framesWithFace": 90, "framesCenterCrop": 6,
  "avgFrameMs": 35.2, "maxFrameMs": 80.1, "windowsSent": 6, "windowsUnsent": 0 }
```

### Backend notes

- **Body size.** One request is ~1.6 MB. NestJS/Express allow only 100 kb by default, so raise it,
  e.g. in `main.ts`: `app.use(json({ limit: '10mb' }))`.
- **Decode in Python:**
  ```python
  import base64, numpy as np
  frames = np.frombuffer(base64.b64decode(body["frames"]["data"]), dtype=np.uint8).reshape(16, 160, 160, 3)
  landmarks = np.array(body["landmarks"], dtype=np.float32)          # (16, 52, 3)
  valid = np.array(body["faceDetected"])                              # (16,) False -> zero landmarks
  ```
- Image layout is `[frame][row][column][R,G,B]`, values 0-255 (not normalized).

---

## 5. Settings (`config.js`)

| Setting | Default | Meaning |
|---------|---------|---------|
| `BACKEND_BASE_URL` | `http://localhost:3000` | Your backend. Use https in production. |
| `FRAMES_ENDPOINT` | `/engagement/frames` | Receives one window (frames + landmarks). |
| `SESSION_ENDPOINT` | `/engagement/sessions` | Receives the summary on Save. |
| `WINDOW_SECONDS` | `10` | Length of the capture part of one cycle. |
| `FRAMES_PER_WINDOW` | `16` | Frames per window (interval = `WINDOW_SECONDS` / this). |
| `BREAK_SECONDS` | `20` | Rest time after each window before the next one starts. Set `0` for back-to-back windows. |
| `CROP_SCALE` | `1.5` | How much the face box is enlarged before cropping. Bigger = more body. |
| `OUTPUT_SIZE` | `160` | Side of the square output image (160 -> 160 x 160 x 3). |
| `SEND_PARTIAL_WINDOW` | `false` | If Save is clicked mid-window: `true` sends the unfinished window (missing frames zero-filled, `partial: true`), `false` drops it. |
| `MAX_QUEUED_WINDOWS` | `6` | Windows kept in memory if the backend is down (about 1.6 MB each). Oldest are dropped first. |

If the backend is unreachable, windows wait in the queue and are retried; the Save button reports
how many could not be delivered.

---

## 6. Files

| File | Job |
|------|-----|
| `offscreen.js` | The whole capture pipeline: camera, scheduler, Face Mesh, crop, 160x160 RGB, stacking, timing. |
| `config.js` | Settings and the 52 landmark indices. |
| `background.js` | Google login, uploads to the backend, Save/stop handling. |
| `content.js` | Reads the Meet page (in a call? camera on? host or participant?). |
| `popup.*`, `options.*` | The extension UI. |
| `vendor/face_mesh` | `@mediapipe/face_mesh` from npm, with one line patched (`createNamedFunction` no longer uses `new Function`) so it runs under Chrome's Manifest V3 CSP. |

## 7. Quick troubleshooting

- **Many `"source": "center"` frames:** face is too small, too dark, or turned away; check the camera.
- **`frame took ... ms` warnings:** the machine is slow; lower `OUTPUT_SIZE` or `FRAMES_PER_WINDOW`.
- **Backend returns 413:** body limit too small, see Backend notes.
- **Nothing is captured:** the camera must be ON in Meet, and the call must be active (not the lobby).
