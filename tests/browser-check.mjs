import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { playerOperation } from "../extension/player.js";

const output = fileURLToPath(new URL("../test-output/", import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent(
    '<html><body style="background:#101010;color:white;font:20px Arial;padding:30px">YouTube Music fixture</body></html>',
  );
  await page.evaluate(() => {
    // Expose the isolated panel to the test without changing the shipped closed shadow root.
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      return attachShadow.call(this, { ...options, mode: "open" });
    };
    window.messages = [];
    window.listeners = [];
    window.chrome = {
      runtime: {
        onMessage: {
          addListener(listener) {
            window.listeners.push(listener);
          },
        },
        async sendMessage(message) {
          window.messages.push(message);
          return { ok: true, state: { role: "Idle" } };
        },
      },
    };
  });
  await page.addScriptTag({
    path: fileURLToPath(
      new URL("../extension/keyboard-guard.js", import.meta.url),
    ),
  });
  await page.evaluate(() => {
    window.siteKeys = [];
    for (const type of ["keydown", "keypress", "keyup"]) {
      window.addEventListener(
        type,
        (event) => window.siteKeys.push(event.key),
        true,
      );
    }
    const queue = document.createElement("ytmusic-player-queue");
    queue.id = "queue";
    queue.style.cssText =
      "position:absolute;top:500px;left:180px;width:150px;height:100px;transform:translateZ(0);overflow:hidden";
    document.body.append(queue);
  });
  await page.addScriptTag({
    path: fileURLToPath(
      new URL("../extension/vendor/lucide.min.js", import.meta.url),
    ),
  });
  await page.addScriptTag({
    path: fileURLToPath(new URL("../extension/vendor/qr.js", import.meta.url)),
  });
  await page.addScriptTag({
    path: fileURLToPath(new URL("../extension/content.js", import.meta.url)),
  });
  await page.getByRole("button", { name: "Jam", exact: true }).click();
  await page.getByLabel("Short code or invitation link").focus();
  await page.keyboard.press("Shift+N");
  await page.keyboard.type("k-");
  assert.equal(
    await page.getByLabel("Short code or invitation link").inputValue(),
    "Nk-",
  );
  assert.deepEqual(await page.evaluate(() => window.siteKeys), []);
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .locator("#join")
      .evaluate((button) => button === button.getRootNode().activeElement),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#panel").isVisible(), false);
  await page.mouse.click(20, 20);
  await page.keyboard.press("k");
  assert.ok((await page.evaluate(() => window.siteKeys)).includes("k"));
  await page.getByRole("button", { name: "Jam", exact: true }).click();
  await page.getByRole("button", { name: "Start Jam", exact: true }).click();
  assert.equal(await page.evaluate(() => window.messages.at(-1).type), "HOST");
  await page.evaluate(() => {
    for (const listener of window.listeners)
      listener({
        type: "JAM_STATE",
        state: {
          role: "Host",
          invite:
            "morphejam://join?v=2&jam=11111111-1111-1111-1111-111111111111&secret=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG&exp=1790600000000",
          code: "ABCD-EFGH",
          codeExpires: Date.now() + 600000,
          connected: true,
          peers: 2,
          allowGuestEdits: true,
          snapshot: {
            revision: "test:1",
            items: [
              {
                id: "1",
                videoId: "abcdefghijk",
                title:
                  "A very long song title to check narrow layouts and text clipping",
                artist: "Artist name",
                current: true,
              },
              {
                id: "2",
                videoId: "12345678901",
                title: "Another track",
                artist: "Another artist",
              },
            ],
            autoplay: [],
            clock: { playing: true, position: 67000, duration: 215000 },
          },
        },
      });
  });
  await page.waitForFunction(() => {
    const canvas = document
      .getElementById("morphe-jam-extension")
      .shadowRoot.getElementById("invitation-qr");
    return JamQr.read(canvas)?.startsWith("morphejam://join?");
  });
  assert.equal(await page.locator("#short-code").textContent(), "ABCD-EFGH");
  await page.screenshot({ path: `${output}/panel-desktop.png` });
  await page.getByLabel("Song link or video ID").fill("abcdefghijk");
  await page.getByRole("button", { name: "Add to queue", exact: true }).click();
  const add = await page.evaluate(() => window.messages.at(-1));
  assert.equal(add.command.op, "ADD");
  assert.equal(add.command.videoId, "abcdefghijk");
  await page.setViewportSize({ width: 360, height: 740 });
  await page.screenshot({ path: `${output}/panel-narrow.png` });
  const bounds = await page
    .locator("#morphe-jam-extension")
    .evaluate((container) => {
      const panel = container.shadowRoot.getElementById("panel");
      const rectangle = panel.getBoundingClientRect();
      return {
        left: rectangle.left,
        right: rectangle.right,
        scroll: panel.scrollWidth,
        width: panel.clientWidth,
      };
    });
  assert.ok(bounds.left >= 0 && bounds.right <= 360);
  assert.ok(bounds.scroll <= bounds.width);
  for (const viewport of [
    { width: 1280, height: 420 },
    { width: 320, height: 480 },
    { width: 640, height: 300 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(100);
    const layout = await page.locator("#panel").evaluate((panel) => {
      const box = panel.getBoundingClientRect();
      const body = panel.querySelector(".body");
      body.scrollTop = body.scrollHeight;
      return {
        top: box.top,
        left: box.left,
        bottom: box.bottom,
        right: box.right,
        scrolling: body.scrollTop > 0,
        topLayer: panel.matches(":popover-open"),
      };
    });
    assert.ok(
      layout.top >= 0 &&
        layout.left >= 0 &&
        layout.right <= viewport.width &&
        layout.bottom <= viewport.height,
      JSON.stringify(layout),
    );
    assert.ok(layout.scrolling && layout.topLayer);
    await page
      .getByRole("button", { name: "Refresh queue", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Close panel", exact: true })
      .click();
    await page.getByRole("button", { name: "Jam", exact: true }).click();
  }
  await page.screenshot({ path: `${output}/panel-short-viewport.png` });
  const qrImage = await page
    .locator("#invitation-qr")
    .evaluate((canvas) => canvas.toDataURL().split(",")[1]);
  await page.evaluate(() => {
    for (const listener of window.listeners)
      listener({ type: "JAM_STATE", state: { role: "Idle" } });
  });
  await page.locator("#qr-file").setInputFiles({
    name: "invitation.png",
    mimeType: "image/png",
    buffer: Buffer.from(qrImage, "base64"),
  });
  await page.waitForFunction(() =>
    document
      .getElementById("morphe-jam-extension")
      .shadowRoot.getElementById("invitation")
      .value.startsWith("morphejam://"),
  );
  await page.getByRole("button", { name: "Join Jam", exact: true }).click();
  assert.equal(await page.evaluate(() => window.messages.at(-1).type), "JOIN");
  await page.getByLabel("Short code or invitation link").fill("ABCD-EFGH");
  await page.getByRole("button", { name: "Join Jam", exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.messages.at(-1).type),
    "JOIN_CODE",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Panel actions, desktop/narrow layout, and JavaScript errors: passed",
  );

  const extensionPath = fileURLToPath(
    new URL("../extension/", import.meta.url),
  );
  const extensionContext = await chromium.launchPersistentContext(
    `${output}/chrome-profile`,
    {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    },
  );
  try {
    const worker =
      extensionContext.serviceWorkers()[0] ||
      (await extensionContext.waitForEvent("serviceworker"));
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    assert.equal(manifest.name, "Morphe Jam for YouTube Music");
    console.log(
      `Manifest V3 service worker loaded: ${worker.url().split("/")[2]}`,
    );
    if (process.argv.includes("--native")) {
      const response = await worker.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const port = chrome.runtime.connectNative("app.morphe.jam.chrome");
            const timeout = setTimeout(() => {
              port.disconnect();
              reject(Error("Native helper timed out"));
            }, 10000);
            port.onDisconnect.addListener(() => {
              clearTimeout(timeout);
              if (chrome.runtime.lastError)
                reject(Error(chrome.runtime.lastError.message));
            });
            port.onMessage.addListener((message) => {
              if (message.requestId === "smoke") {
                clearTimeout(timeout);
                resolve(message.result);
                port.disconnect();
              }
            });
            port.postMessage({ type: "STATE", requestId: "smoke" });
          }),
      );
      assert.equal(response.state.role, "Idle");
      console.log(
        "Chrome native messaging and Windows helper registration: passed",
      );
    }
  } finally {
    await extensionContext.close();
  }
} finally {
  await browser.close();
}
