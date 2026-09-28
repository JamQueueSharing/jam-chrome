(() => {
  if (document.getElementById("morphe-jam-extension")) return;
  const container = document.createElement("div");
  container.id = "morphe-jam-extension";
  const root = container.attachShadow({ mode: "closed" });
  document.documentElement.append(container);
  root.innerHTML = `
    <style>
      :host { all: initial; color-scheme: dark; font: 14px/1.4 Arial, sans-serif; color: #f5f5f5; letter-spacing: 0; }
      * { box-sizing: border-box; }
      button, input, textarea { font: inherit; }
      button { cursor: pointer; border: 1px solid #505050; border-radius: 5px; background: #282828; color: inherit; min-height: 36px; padding: 7px 12px; }
      button:hover { background: #393939; }
      button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid #64dfb2; outline-offset: 2px; }
      button:disabled { opacity: .4; cursor: default; }
      input, textarea { color: inherit; border: 1px solid #505050; border-radius: 4px; background: #121212; padding: 9px; width: 100%; min-width: 0; }
      textarea { min-height: 74px; resize: vertical; }
      label { display: block; color: #cecece; margin-bottom: 6px; }
      [hidden] { display: none !important; }
      h2 { margin: 0; font-size: 19px; font-weight: 600; }
      h3 { margin: 14px 0 8px; font-size: 13px; color: #bdbdbd; }
      :host([data-native]) { display: block; padding: 8px 12px; }
      :host([data-native]) .launch { position: static; width: 100%; text-align: left; }
      .launch { position: fixed; z-index: 2147483645; right: 20px; bottom: 94px; background: #12674f; border-color: #398c70; }
      .panel { position: fixed; z-index: 2147483646; inset: auto; top: var(--panel-top, 12px); left: var(--panel-left, 12px); margin: 0; width: min(420px, var(--panel-width, calc(100vw - 24px))); max-height: var(--panel-height, calc(100dvh - 24px)); color: #f5f5f5; background: #191919; border: 1px solid #494949; border-radius: 8px; box-shadow: 0 12px 45px #0008; display: flex; flex-direction: column; overflow: hidden; }
      header { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 16px 9px; }
      .body { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 0 16px 16px; }
      .status { color: #77ddbc; margin: 0 0 12px; }
      .error { color: #ffaeae; overflow-wrap: anywhere; margin: 8px 0; }
      .row { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
      .row > input { flex: 1; }
      .primary { background: #12674f; border-color: #398c70; }
      .danger { color: #ffb4b4; }
      .icon { width: 34px; min-width: 34px; height: 34px; min-height: 34px; padding: 7px; display: inline-flex; align-items: center; justify-content: center; }
      svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .queue { list-style: none; padding: 0; margin: 0; }
      .track { display: grid; grid-template-columns: 38px minmax(0,1fr) auto; gap: 8px; align-items: center; border-top: 1px solid #333; padding: 9px 0; }
      .track.current { border-left: 3px solid #64dfb2; padding-left: 6px; }
      .track img { width: 38px; height: 38px; border-radius: 3px; object-fit: cover; background: #333; }
      .title, .artist { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .artist { font-size: 12px; color: #aaa; }
      .tools { display: flex; gap: 3px; }
      .tools .icon { width: 28px; min-width: 28px; height: 30px; min-height: 30px; padding: 5px; }
      .toggle { display: flex; align-items: center; gap: 8px; margin: 12px 0; }
      .toggle input { width: 16px; height: 16px; accent-color: #64dfb2; }
      .empty { color: #aaa; padding: 12px 0; }
      .time { font-variant-numeric: tabular-nums; color: #bbb; font-size: 12px; min-width: 78px; text-align: right; }
      input[type=range] { padding: 0; accent-color: #64dfb2; }
      #invitation-qr { display: block; width: min(280px, 100%); height: auto; margin: 12px auto; }
      .pairing-code { display: block; text-align: center; font: 28px monospace; user-select: all; overflow-wrap: anywhere; }
      #code-expiry { text-align: center; color: #bbb; margin: 4px 0; }
      #camera-preview { display: block; width: 100%; max-height: 220px; object-fit: contain; }
      .row.wrap { flex-wrap: wrap; }
      @media (max-width: 380px) { .tools { gap: 0; } .track { gap: 5px; } }
    </style>
    <button class="launch" id="launch">Jam</button>
    <section class="panel" id="panel" popover="manual" aria-label="Morphe Jam" hidden>
      <header><h2>Morphe Jam</h2><button class="icon" id="close" title="Close panel" aria-label="Close panel"></button></header>
      <div class="body">
        <p class="status" id="status">No active Jam</p>
        <p class="error" id="error" role="alert" hidden></p>
        <div id="setup">
          <button class="primary" id="host">Start Jam</button>
          <h3>Join a Jam</h3>
          <label for="invitation">Short code or invitation link</label>
          <textarea id="invitation" placeholder="ABCD-EFGH or morphejam://join?..." spellcheck="false" autocomplete="off"></textarea>
          <div class="row wrap"><button id="join">Join Jam</button><button id="scan-image">Open QR image</button><button id="scan-camera">Scan QR</button></div>
          <input id="qr-file" type="file" accept="image/*" hidden>
          <div id="scanner" hidden><video id="camera-preview" autoplay muted playsinline></video><button id="stop-camera">Stop camera</button></div>
        </div>
        <div id="session" hidden>
          <div id="host-invitation" hidden>
            <canvas id="invitation-qr" aria-label="Jam invitation QR code" role="img"></canvas>
            <output class="pairing-code" id="short-code"></output>
            <p id="code-expiry"></p>
            <div class="row"><button id="copy-code">Copy code</button><button id="new-code">New code</button></div>
          </div>
          <div class="row"><button id="invite">Copy invitation</button><button class="danger" id="leave">Leave Jam</button></div>
          <label class="toggle" id="lock-label"><input type="checkbox" id="allow" checked>Allow guest edits</label>
          <div class="row">
            <button class="icon" id="previous" title="Previous on host" aria-label="Previous on host"></button>
            <button class="icon" id="play" title="Play or pause on host" aria-label="Play or pause on host"></button>
            <button class="icon" id="next" title="Next on host" aria-label="Next on host"></button>
            <input type="range" id="seek" min="0" max="1" value="0" aria-label="Host playback position">
            <span class="time" id="time">0:00 / 0:00</span>
          </div>
          <label for="song">Song link or video ID</label>
          <input id="song" placeholder="https://music.youtube.com/watch?v=..." autocomplete="off">
          <div class="row"><button id="add">Add to queue</button><button id="play-next">Play next</button><button class="icon" id="refresh" title="Refresh queue" aria-label="Refresh queue"></button></div>
        </div>
      </div>
    </section>`;

  // Lucide is bundled locally because extensions cannot load remote scripts.
  const icons = {
    close: "X",
    play: "Play",
    pause: "Pause",
    previous: "SkipBack",
    next: "SkipForward",
    up: "ChevronUp",
    down: "ChevronDown",
    remove: "Trash2",
    refresh: "RefreshCw",
  };
  const element = (id) => root.getElementById(id);
  function positionPanel() {
    const viewport = window.visualViewport;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    const panel = element("panel");
    panel.style.setProperty(
      "--panel-top",
      `${(viewport?.offsetTop || 0) + 12}px`,
    );
    panel.style.setProperty(
      "--panel-left",
      `${(viewport?.offsetLeft || 0) + Math.max(12, width - 432)}px`,
    );
    panel.style.setProperty("--panel-width", `${Math.max(0, width - 24)}px`);
    panel.style.setProperty("--panel-height", `${Math.max(0, height - 24)}px`);
  }
  function setPanelOpen(open) {
    const panel = element("panel");
    if (open) {
      positionPanel();
      panel.hidden = false;
      if (!panel.matches(":popover-open")) panel.showPopover();
    } else {
      if (panel.matches(":popover-open")) panel.hidePopover();
      panel.hidden = true;
      stopCamera();
      element("launch").focus();
    }
  }
  window.addEventListener("resize", positionPanel);
  window.visualViewport?.addEventListener("resize", positionPanel);
  window.visualViewport?.addEventListener("scroll", positionPanel);
  const icon = (name) =>
    lucide.createElement(lucide.icons[icons[name]], { "aria-hidden": "true" })
      .outerHTML;
  for (const name of ["close", "previous", "play", "next", "refresh"])
    element(name).innerHTML = icon(name);
  let state = { role: "Idle" };
  let busy = false;
  let displayedInvitation = "";
  let cameraStream;
  let scanFrame;
  let cameraGeneration = 0;

  function stopCamera() {
    cameraGeneration++;
    cancelAnimationFrame(scanFrame);
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    element("camera-preview").srcObject = null;
    element("scanner").hidden = true;
  }

  function acceptQr(value) {
    if (!value?.startsWith("morphejam://join?"))
      throw Error("This image does not contain a Morphe Jam invitation");
    element("invitation").value = value;
    stopCamera();
  }

  onVisibilityChange();
  function onVisibilityChange() {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopCamera();
    });
    window.addEventListener("pagehide", stopCamera);
  }

  function showError(message = "") {
    element("error").textContent = message;
    element("error").hidden = !message;
  }
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw Error(response?.error || "Jam did not respond");
    return response;
  }
  async function action(task) {
    if (busy) return;
    busy = true;
    showError();
    render();
    try {
      await task();
    } catch (error) {
      showError(error.message);
    } finally {
      busy = false;
      render();
    }
  }
  function command(op, fields = {}) {
    return send({
      type: "COMMAND",
      command: { op, revision: state.snapshot?.revision, ...fields },
    });
  }
  const onClick = (id, task) =>
    element(id).addEventListener("click", () => action(task));
  element("launch").onclick = () => {
    setPanelOpen(element("panel").hidden);
  };
  element("close").onclick = () => {
    setPanelOpen(false);
  };
  container.addEventListener("jam-close", () => setPanelOpen(false));
  onClick("host", () => send({ type: "HOST" }));
  onClick("join", async () => {
    stopCamera();
    const value = element("invitation").value.trim();
    await send(
      value.startsWith("morphejam:")
        ? { type: "JOIN", invite: value }
        : { type: "JOIN_CODE", code: value },
    );
    element("invitation").value = "";
  });
  onClick("copy-code", () => navigator.clipboard.writeText(state.code));
  onClick("new-code", () => send({ type: "REFRESH_CODE" }));
  onClick("scan-image", () => element("qr-file").click());
  element("qr-file").onchange = () =>
    action(async () => {
      const file = element("qr-file").files[0];
      element("qr-file").value = "";
      if (!file) return;
      if (file.size > 20000000)
        throw Error("Choose an image smaller than 20 MB");
      const bitmap = await createImageBitmap(file);
      try {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas
          .getContext("2d")
          .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        acceptQr(JamQr.read(canvas));
      } finally {
        bitmap.close();
      }
    });
  element("stop-camera").onclick = stopCamera;
  onClick("scan-camera", async () => {
    stopCamera();
    const generation = cameraGeneration;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 } },
      audio: false,
    });
    if (
      generation !== cameraGeneration ||
      element("panel").hidden ||
      state.role !== "Idle"
    ) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    cameraStream = stream;
    const video = element("camera-preview");
    element("scanner").hidden = false;
    video.srcObject = stream;
    try {
      await video.play();
    } catch (error) {
      stopCamera();
      throw error;
    }
    const canvas = document.createElement("canvas");
    let lastScan = 0;
    function scan(now) {
      if (!cameraStream) return;
      if (video.readyState >= 2 && now - lastScan > 250) {
        lastScan = now;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0);
        const value = JamQr.read(canvas);
        if (value?.startsWith("morphejam://join?")) {
          acceptQr(value);
          return;
        }
      }
      scanFrame = requestAnimationFrame(scan);
    }
    scanFrame = requestAnimationFrame(scan);
  });
  // Leaving remains available while a connection or mutation is pending.
  element("leave").onclick = () =>
    send({ type: "END" }).catch((error) => showError(error.message));
  onClick("invite", async () => {
    await navigator.clipboard.writeText(state.invite);
    element("invite").textContent = "Copied";
    setTimeout(() => {
      element("invite").textContent = "Copy invitation";
    }, 1800);
  });
  element("allow").onchange = () =>
    action(() => send({ type: "LOCK", allow: element("allow").checked }));
  onClick("previous", () => command("SKIP_PREVIOUS"));
  onClick("next", () => command("SKIP_NEXT"));
  onClick("refresh", () => command("SNAPSHOT"));
  onClick("play", () => {
    const current = state.snapshot?.items.find((row) => row.current);
    if (!current) throw Error("No current host track");
    return command("PLAY", {
      item: current.id,
      videoId: current.videoId,
      playing: !state.snapshot.clock?.playing,
    });
  });
  element("seek").onchange = () =>
    action(() =>
      command("SEEK", {
        videoId: state.snapshot?.clock?.videoId,
        position: Number(element("seek").value),
      }),
    );
  function songId() {
    let value = element("song").value.trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(value)) {
      const url = new URL(value);
      if (
        ![
          "music.youtube.com",
          "www.youtube.com",
          "youtube.com",
          "youtu.be",
        ].includes(url.hostname)
      )
        throw Error("Enter a YouTube Music song link");
      value =
        url.hostname === "youtu.be"
          ? url.pathname.slice(1)
          : url.searchParams.get("v");
    }
    if (!/^[A-Za-z0-9_-]{11}$/.test(value))
      throw Error("Enter a single song link or 11-character video ID");
    return value;
  }
  for (const [id, op] of [
    ["add", "ADD"],
    ["play-next", "PLAY_NEXT"],
  ])
    onClick(id, async () => {
      await command(op, { videoId: songId() });
      element("song").value = "";
    });

  function formatTime(milliseconds) {
    const seconds = Math.max(0, Math.floor((milliseconds || 0) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  function render() {
    const active = ["Host", "Participant"].includes(state.role);
    element("setup").hidden = active || state.role === "OtherTab";
    element("session").hidden = !active;
    if (active && cameraStream) stopCamera();
    element("host-invitation").hidden = state.role !== "Host";
    if (
      state.role === "Host" &&
      state.invite &&
      displayedInvitation !== state.invite
    ) {
      displayedInvitation = state.invite;
      JamQr.draw(element("invitation-qr"), state.invite).catch((error) =>
        showError(error.message),
      );
    }
    if (state.role !== "Host") {
      displayedInvitation = "";
      element("invitation-qr").getContext("2d").clearRect(0, 0, 300, 300);
    }
    renderCode();
    element("invite").hidden = state.role !== "Host";
    element("lock-label").hidden = state.role !== "Host";
    element("allow").checked = state.allowGuestEdits !== false;
    element("leave").textContent =
      state.role === "Host" ? "End Jam" : "Leave Jam";
    element("status").textContent =
      state.role === "OtherTab"
        ? "Jam is open in another tab"
        : state.role === "Host"
          ? `Hosting / ${state.peers || 0} participant${state.peers === 1 ? "" : "s"}`
          : state.role === "Participant"
            ? state.connected
              ? "Joined / host plays audio"
              : "Connecting to host..."
            : busy
              ? "Starting Jam..."
              : "No active Jam";
    for (const id of ["host", "join", "allow", "invite"])
      element(id).disabled = busy;
    for (const id of [
      "add",
      "play-next",
      "previous",
      "next",
      "play",
      "seek",
      "refresh",
    ])
      element(id).disabled = busy || !state.connected;
    const snapshot = state.snapshot || {};
    const clock = snapshot.clock || {};
    element("play").innerHTML = icon(clock.playing ? "pause" : "play");
    if (root.activeElement !== element("seek")) {
      element("seek").max = String(clock.duration || 1);
      element("seek").value = String(clock.position || 0);
    }
    element("time").textContent =
      `${formatTime(clock.position)} / ${formatTime(clock.duration)}`;
  }
  function renderCode() {
    const remaining = Math.max(0, (state.codeExpires || 0) - Date.now());
    element("short-code").textContent = remaining
      ? state.code || ""
      : "Code expired";
    element("code-expiry").textContent = remaining
      ? `Expires in ${formatTime(remaining)}`
      : "";
    element("copy-code").disabled = busy || !remaining;
    element("new-code").disabled = busy;
  }
  setInterval(renderCode, 1000);
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "JAM_OPEN") setPanelOpen(true);
    if (message.type === "JAM_ERROR") {
      showError(message.error);
      setPanelOpen(true);
    }
    if (message.type === "JAM_STATE") {
      state = message.state;
      if (state.error) showError(state.error);
      render();
    }
  });
  function mountInNativeQueue() {
    const queue = document.querySelector("ytmusic-player-queue#queue");
    if (queue && container.parentNode !== queue) {
      queue.prepend(container);
      container.setAttribute("data-native", "");
    }
  }
  new MutationObserver(mountInNativeQueue).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  mountInNativeQueue();
  send({ type: "STATE" })
    .then((response) => {
      state = response.state;
      render();
    })
    .catch((error) => showError(error.message));
})();
