import { playerOperation } from "./player.js";
import { nativeQueueIntegration } from "./native-queue.js";

let nativePort = null;
let sessionTab = null;
let starting = false;
let state = { role: "Idle", connected: false, peers: 0 };
const pending = new Map();
let mirrorBusy = false;

async function updateNativeQueue() {
  if (sessionTab === null || mirrorBusy) return;
  mirrorBusy = true;
  try {
    const tabId = sessionTab;
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: nativeQueueIntegration,
      args: [
        {
          state: {
            role: state.role,
            connected: state.connected,
            snapshot: state.snapshot,
          },
        },
      ],
    });
    const result = results[0]?.result;
    if (results[0]?.error) throw Error(results[0].error.message);
    if (result?.error)
      chrome.tabs
        .sendMessage(tabId, { type: "JAM_ERROR", error: result.error })
        .catch(() => {});
    for (const command of result?.commands || []) {
      if (sessionTab !== tabId || state.role !== "Participant") break;
      const response = await requestHelper({
        type: "COMMAND",
        command: { ...command, id: crypto.randomUUID() },
      });
      if (!response.ok)
        chrome.tabs
          .sendMessage(tabId, { type: "JAM_ERROR", error: response.error })
          .catch(() => {});
    }
  } catch (error) {
    if (sessionTab !== null)
      chrome.tabs
        .sendMessage(sessionTab, { type: "JAM_ERROR", error: error.message })
        .catch(() => {});
  } finally {
    mirrorBusy = false;
    if (state.role !== "Participant") void restoreNativeQueue();
  }
}

async function restoreNativeQueue() {
  if (sessionTab === null) return;
  await chrome.scripting
    .executeScript({
      target: { tabId: sessionTab },
      world: "MAIN",
      func: nativeQueueIntegration,
      args: [{ state: { role: "Idle" } }],
    })
    .catch(() => {});
}

// Native messaging keeps this worker alive throughout a Jam session.
setInterval(() => {
  if (state.role === "Participant") void updateNativeQueue();
}, 250);

async function runPlayer(command) {
  if (sessionTab === null) throw Error("The Jam tab was closed");
  const results = await chrome.scripting.executeScript({
    target: { tabId: sessionTab },
    world: "MAIN",
    func: playerOperation,
    args: [command],
  });
  if (results[0]?.error)
    throw Error(results[0].error.message || "Player request failed");
  if (!results[0]?.result) throw Error("No response from YouTube Music");
  return results[0].result;
}

function broadcast() {
  if (state.role === "Participant") void updateNativeQueue();
  else void restoreNativeQueue();
  if (sessionTab !== null)
    chrome.tabs
      .sendMessage(sessionTab, { type: "JAM_STATE", state })
      .catch(() => {});
  chrome.action.setBadgeText({
    text: state.role === "Idle" ? "" : state.role === "Host" ? "HOST" : "JOIN",
  });
  chrome.action.setBadgeBackgroundColor({ color: "#157b61" });
}

function connectHelper() {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative("app.morphe.jam.chrome");
  nativePort = port;
  port.onMessage.addListener(async (message) => {
    if (port !== nativePort) return;
    if (message.type === "player") {
      try {
        const result = await runPlayer(message.command);
        if (port === nativePort)
          port.postMessage({
            type: "playerResult",
            requestId: message.requestId,
            result,
          });
      } catch (error) {
        if (port === nativePort)
          port.postMessage({
            type: "playerResult",
            requestId: message.requestId,
            error: error.message,
          });
      }
    } else if (message.type === "state") {
      state = message.state;
      broadcast();
      if (state.role === "Participant") {
        runPlayer({ op: "PAUSE" }).catch(() => {});
      }
    } else {
      const request = pending.get(message.requestId);
      if (request) {
        clearTimeout(request.timer);
        pending.delete(message.requestId);
        request.resolve(message.result);
      }
    }
  });
  port.onDisconnect.addListener(() => {
    const details = chrome.runtime.lastError?.message || "The helper stopped";
    if (nativePort !== port) return;
    nativePort = null;
    state = {
      role: "Idle",
      connected: false,
      peers: 0,
      error: `${details}. Install the Jam helper using install-windows.ps1.`,
    };
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(Error(state.error));
    }
    pending.clear();
    broadcast();
  });
  return port;
}

function requestHelper(message) {
  return new Promise((resolve, reject) => {
    if (pending.size >= 32)
      return reject(
        Error("Too many pending requests; wait for the current operation"),
      );
    const port = connectHelper();
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(
        Error(
          "Request timed out. Outcome unknown; wait for the queue to refresh.",
        ),
      );
    }, 60000);
    pending.set(requestId, { resolve, reject, timer });
    try {
      port.postMessage({ ...message, requestId });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(error);
    }
  });
}

async function handle(message, sender) {
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    JSON.stringify(message).length > 16384
  )
    throw Error("Invalid request");
  if (
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    !sender.tab ||
    new URL(sender.url).origin !== "https://music.youtube.com"
  )
    throw Error("Untrusted sender");
  if (message.type === "STATE") {
    if (state.role === "Idle") {
      await chrome.scripting
        .executeScript({
          target: { tabId: sender.tab.id },
          world: "MAIN",
          func: nativeQueueIntegration,
          args: [{ state: { role: "Idle" } }],
        })
        .catch(() => {});
    }
    return {
      ok: true,
      state:
        sessionTab === null || sessionTab === sender.tab.id
          ? state
          : { role: "OtherTab", connected: false, peers: 0 },
    };
  }
  if (["HOST", "JOIN", "JOIN_CODE"].includes(message.type)) {
    if (starting || state.role !== "Idle")
      throw Error("A Jam is already active. Leave it before starting another.");
    starting = true;
    sessionTab = sender.tab.id;
    try {
      if (message.type !== "HOST") {
        const value =
          message.type === "JOIN_CODE" ? message.code : message.invite;
        if (typeof value !== "string" || value.length > 1024)
          throw Error("Invalid invitation");
        await runPlayer({ op: "PAUSE" });
      }
      return await requestHelper({
        type: message.type,
        invite: message.invite,
        code: message.code,
      });
    } finally {
      starting = false;
    }
  }
  if (sessionTab !== sender.tab.id)
    throw Error("Open the YouTube Music tab running this Jam");
  if (message.type === "END") return requestHelper({ type: "END" });
  if (message.type === "REFRESH_CODE")
    return requestHelper({ type: "REFRESH_CODE" });
  if (message.type === "LOCK")
    return requestHelper({ type: "LOCK", allow: message.allow === true });
  if (message.type !== "COMMAND") throw Error("Unsupported request");
  const allowed = [
    "ADD",
    "PLAY_NEXT",
    "REMOVE",
    "MOVE",
    "PLAY",
    "SEEK",
    "SKIP_NEXT",
    "SKIP_PREVIOUS",
    "SNAPSHOT",
  ];
  if (!allowed.includes(message.command?.op))
    throw Error("Unsupported queue command");
  if (JSON.stringify(message.command).length > 4096)
    throw Error("Command too large");
  return requestHelper({
    type: "COMMAND",
    command: { ...message.command, id: crypto.randomUUID() },
  });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(respond, (error) =>
    respond({ ok: false, error: error.message }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === sessionTab) {
    requestHelper({ type: "END" }).catch(() => {});
    sessionTab = null;
  }
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (
    tabId === sessionTab &&
    change.url &&
    !change.url.startsWith("https://music.youtube.com/")
  ) {
    requestHelper({ type: "END" }).catch(() => {});
  }
});

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: "https://music.youtube.com/*" });
  const tab = tabs.find((tab) => tab.id === sessionTab) || tabs[0];
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    chrome.tabs.sendMessage(tab.id, { type: "JAM_OPEN" }).catch(() => {});
  } else await chrome.tabs.create({ url: "https://music.youtube.com/" });
});
