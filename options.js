const btn = document.getElementById("btn-grant");
const statusEl = document.getElementById("status");
const preview = document.getElementById("preview");

btn.addEventListener("click", async () => {
  btn.disabled = true;
  btn.textContent = "Requesting…";
  statusEl.className = "";
  statusEl.textContent = "";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });

    // Briefly show a live preview so the user can see it actually worked,
    // then release the camera — the extension only needs the *permission*
    // granted for this origin, not an open stream right now.
    preview.srcObject = stream;
    preview.style.display = "block";

    setTimeout(() => {
      stream.getTracks().forEach((t) => t.stop());
      preview.style.display = "none";
    }, 2000);

    await chrome.storage.local.set({ cameraGranted: true });

    statusEl.textContent = "Camera access granted. You can close this tab and go back to the extension.";
    statusEl.className = "ok";
    btn.textContent = "Granted";
  } catch (err) {
    statusEl.textContent = `Camera access failed: ${err.name} — ${err.message}`;
    statusEl.className = "err";
    btn.disabled = false;
    btn.textContent = "Try again";
  }
});

// Reflect current state if the user revisits this page.
(async () => {
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const status = await navigator.permissions.query({ name: "camera" });
      if (status.state === "granted") {
        statusEl.textContent = "Camera access is already granted.";
        statusEl.className = "ok";
        btn.textContent = "Re-grant (optional)";
      }
    }
  } catch (e) {
    // ignore — not all contexts support querying "camera" permission state
  }
})();
