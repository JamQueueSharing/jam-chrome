import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { playerOperation } from "../extension/player.js";
import { nativeQueueIntegration } from "../extension/native-queue.js";

const output = fileURLToPath(new URL("../test-output/", import.meta.url));
await mkdir(output, { recursive: true });
const extensionPath = fileURLToPath(new URL("../extension/", import.meta.url));
const browser = await chromium.launchPersistentContext(
  `${output}/live-profile`,
  {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  },
);
try {
  const page = await browser.newPage();
  await page.goto("https://music.youtube.com/watch?v=YQHsXMglC9A", {
    waitUntil: "domcontentloaded",
  });
  if (page.url().includes("consent.youtube.com")) {
    await page
      .getByRole("button", { name: /Reject all|Odmítnout vše/i })
      .click();
  }
  await page.waitForFunction(
    () => document.querySelector("#queue")?.queue?.store?.store?.getState,
  );
  await page.waitForFunction(
    () =>
      document.querySelector("#queue")?.queue?.store?.store?.getState().queue
        .items.length > 0,
    { timeout: 15000 },
  );
  await page.evaluate(() =>
    document.querySelector("#queue").dispatch({ type: "CLEAR" }),
  );
  assert.equal(new URL(page.url()).origin, "https://music.youtube.com");

  await page.evaluate(playerOperation, { op: "ADD", videoId: "YQHsXMglC9A" });
  await page.evaluate(playerOperation, { op: "ADD", videoId: "kJQP7kiw5Fk" });
  let state = await page.evaluate(playerOperation, { op: "READ" });
  assert.deepEqual(
    state.items.map((row) => row.videoId),
    ["YQHsXMglC9A", "kJQP7kiw5Fk"],
  );
  const firstNativeId = state.items[0].nativeId;
  await page.evaluate(playerOperation, {
    op: "MOVE",
    fromIndex: 0,
    toIndex: 1,
  });
  state = await page.evaluate(playerOperation, { op: "READ" });
  assert.equal(state.items[1].nativeId, firstNativeId);
  assert.equal(state.items[0].videoId, "kJQP7kiw5Fk");
  await page.evaluate(playerOperation, { op: "REMOVE", index: 0 });
  state = await page.evaluate(playerOperation, { op: "READ" });
  assert.equal(state.items.length, 1);
  console.log(
    "Live native queue: add, move, remove and stable occurrence IDs passed",
  );

  const remoteState = {
    role: "Participant",
    connected: true,
    snapshot: {
      revision: "phone:1",
      items: [
        {
          id: "1001",
          videoId: "YQHsXMglC9A",
          title: "Host queue / first track",
          artist: "Adele",
          current: true,
        },
        {
          id: "1002",
          videoId: "kJQP7kiw5Fk",
          title: "Host queue / second track",
          artist: "Luis Fonsi",
        },
      ],
      autoplay: [
        {
          id: "1003",
          videoId: "YQHsXMglC9A",
          title: "Host autoplay track",
          artist: "Adele",
        },
      ],
      clock: { playing: true },
    },
  };
  await page.evaluate(nativeQueueIntegration, { state: remoteState });
  await page.waitForFunction(() =>
    [...document.querySelectorAll("ytmusic-player-queue-item")].some((row) =>
      row.textContent.includes("Host queue / first track"),
    ),
  );
  const titles = await page
    .locator("ytmusic-player-queue-item")
    .allTextContents();
  assert.equal(titles.length, 3);
  for (const [index, title] of [
    "Host queue / first track",
    "Host queue / second track",
    "Host autoplay track",
  ].entries())
    assert.ok(titles[index].includes(title));

  await page.evaluate(() => {
    const queue = document.querySelector("#queue");
    queue.queue.store.store.dispatch({
      type: "SET_PLAYER_PAGE_INFO",
      payload: { open: true },
    });
    queue.dispatch({
      type: "MOVE_ITEM",
      payload: { fromIndex: 0, toIndex: 1 },
    });
    queue.dispatch({ type: "REMOVE_ITEM", payload: 2 });
    queue.dispatch({ type: "SET_INDEX", payload: 1 });
  });
  const actions = await page.evaluate(nativeQueueIntegration, {
    state: remoteState,
  });
  assert.deepEqual(
    actions.commands.map((command) => command.op),
    ["MOVE", "REMOVE", "PLAY"],
  );
  assert.equal(actions.commands[0].item, "1001");
  assert.equal(actions.commands[0].target, "1002");
  assert.equal(actions.commands[1].lane, 1);
  assert.equal(actions.commands[2].videoId, "kJQP7kiw5Fk");
  console.log(
    "Live native queue: host rows rendered; native move/remove/select routed to Jam",
  );

  assert.equal(
    await page.locator("ytmusic-player-queue #morphe-jam-extension").count(),
    1,
  );
  if (
    await page.evaluate(
      () =>
        document.querySelector("#queue").queue.store.store.getState().navigation
          .playerUiState !== "PLAYER_PAGE_OPEN",
    )
  ) {
    await page
      .locator("ytmusic-player-bar .middle-controls")
      .dispatchEvent("click");
  }
  await page
    .locator("ytmusic-player-queue")
    .waitFor({ state: "visible", timeout: 5000 });
  await page.locator("ytmusic-player-queue-item").nth(1).click();
  const clicked = await page.evaluate(nativeQueueIntegration, {
    state: remoteState,
  });
  assert.equal(clicked.commands[0]?.op, "PLAY");
  assert.equal(clicked.commands[0]?.item, "1002");
  console.log("Live native row click routes to host playback");
  await page
    .locator("ytmusic-player-queue-item")
    .nth(1)
    .locator("ytmusic-menu-renderer")
    .click();
  await page.getByText("Remove from queue", { exact: true }).click();
  const removed = await page.evaluate(nativeQueueIntegration, {
    state: remoteState,
  });
  assert.equal(removed.commands[0]?.op, "REMOVE");
  assert.equal(removed.commands[0]?.item, "1002");
  console.log("Live native overflow menu routes remove to the host");
  await page.screenshot({ path: `${output}/live-native-queue.png` });

  await page.evaluate(nativeQueueIntegration, { state: { role: "Idle" } });
  await page.waitForFunction(
    () =>
      !document
        .querySelector("#queue")
        .textContent.includes("Host queue / first track"),
  );
  const restored = await page.evaluate(playerOperation, { op: "READ" });
  assert.equal(restored.items.length, 1);
  assert.equal(restored.items[0].videoId, "YQHsXMglC9A");
  assert.equal(restored.items[0].nativeId, firstNativeId);
  console.log("Live native queue: leaving restored the original local queue");
} finally {
  await browser.close();
}
