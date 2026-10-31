#!/usr/bin/env node
// Standalone test server (zero npm dependencies) described in README section 7.
// Listens on http://localhost:3000, validates every incoming 16-frame window,
// and writes each frame as its own PNG (out/window_N/frame_00.png .. frame_15.png)
// plus a 4x4 contact sheet (out/window_N_sheet.png).

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 3000);
const OUT_DIR = path.join(__dirname, "..", "out");

// Minimal pure-JS PNG encoder for raw RGB uint8 buffers (width x height x 3).
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function encodeRgbPng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 = truecolor RGB
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeContactSheet(framesRgb, size) {
  const grid = 4;
  const sheetW = size * grid;
  const sheetH = size * grid;
  const out = Buffer.alloc(sheetW * sheetH * 3);
  for (let idx = 0; idx < Math.min(16, framesRgb.length); idx++) {
    const gx = idx % grid;
    const gy = Math.floor(idx / grid);
    const src = framesRgb[idx];
    for (let y = 0; y < size; y++) {
      const srcOff = y * size * 3;
      const dstOff = ((gy * size + y) * sheetW + gx * size) * 3;
      src.copy(out, dstOff, srcOff, srcOff + size * 3);
    }
  }
  return encodeRgbPng(sheetW, sheetH, out);
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (req.method === "POST" && req.url === "/engagement/frames") {
      try {
        const body = JSON.parse(raw);
        const wIdx = body.windowIndex ?? 0;
        const frames = [...(body.frames || [])].sort((a, b) => a.index - b.index);
        const S = frames[0]?.shape?.[0] || 160;
        const winDir = path.join(OUT_DIR, `window_${wIdx}`);
        fs.mkdirSync(winDir, { recursive: true });

        const rgbBuffers = frames.map((f, i) => {
          const buf = Buffer.from(f.data, "base64");
          const png = encodeRgbPng(S, S, buf);
          fs.writeFileSync(path.join(winDir, `frame_${String(i).padStart(2, "0")}.png`), png);
          return buf;
        });
        if (rgbBuffers.length === 16) {
          fs.writeFileSync(path.join(OUT_DIR, `window_${wIdx}_sheet.png`), makeContactSheet(rgbBuffers, S));
        }
        const faces = (body.faceDetected || []).filter(Boolean).length;
        console.log(
          `[test-server] window #${wIdx} session=${body.sessionId} meeting=${body.meetingId} ` +
            `frames=${frames.length} (${S}x${S}x3) faces=${faces}/16 TIME=${JSON.stringify(body.timing)} -> saved to out/window_${wIdx}`
        );
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, windowIndex: wIdx, faces }));
      } catch (err) {
        console.error("[test-server] bad window:", err.message);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && req.url === "/engagement/sessions") {
      const body = JSON.parse(raw || "{}");
      console.log("[test-server] SESSION SAVED:", body);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, session: body }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "test-server" }));
  });
});

server.listen(PORT, () => {
  console.log(`[test-server] listening on http://localhost:${PORT} (PNG output -> ${OUT_DIR})`);
});
