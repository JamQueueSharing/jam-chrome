import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { randomUUID } from "node:crypto";
import {
  Frames,
  SecureChannel,
  createInvite,
  parseInvite,
} from "../native/protocol.mjs";
import { addresses } from "../native/network.mjs";
import { sanitizeResponse } from "../native/validation.mjs";

function helper() {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../native/host.mjs", import.meta.url)),
  ]);
  const incoming = new Frames(child.stdout, true);
  const requests = new Map();
  let lastState;
  let playerState = {
    items: [{ videoId: "abcdefghijk", title: "First track" }],
    index: 0,
    playing: true,
    position: 15000,
    duration: 180000,
  };

  function send(message) {
    const data = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(data.length);
    child.stdin.write(Buffer.concat([header, data]));
  }
  const reading = (async () => {
    try {
      while (true) {
        const message = JSON.parse((await incoming.read()).toString());
        if (message.type === "state") lastState = message.state;
        else if (message.type === "player") {
          if (message.command.op === "ADD")
            playerState.items.push({ videoId: message.command.videoId });
          send({
            type: "playerResult",
            requestId: message.requestId,
            result: playerState,
          });
        } else {
          requests.get(message.requestId)?.(message.result);
          requests.delete(message.requestId);
        }
      }
    } catch {
      for (const resolve of requests.values())
        resolve({ ok: false, error: "Helper exited" });
    }
  })();
  return {
    get state() {
      return lastState;
    },
    request(message) {
      return new Promise((resolve) => {
        const requestId = randomUUID();
        requests.set(requestId, resolve);
        send({ ...message, requestId });
      });
    },
    async close() {
      const exited = once(child, "exit");
      child.stdin.end();
      await exited;
      await reading;
    },
  };
}

test(
  "native helper hosts, authorizes primary channels, applies edits, locks guests and ends",
  { timeout: 15000 },
  async (context) => {
    if (!addresses().length) {
      context.skip("Requires a private LAN interface");
      return;
    }
    const app = helper();
    let guest;
    try {
      assert.equal((await app.request({ type: "HOST" })).ok, true);
      assert.match(app.state.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      const previousCode = app.state.code;
      assert.equal((await app.request({ type: "REFRESH_CODE" })).ok, true);
      assert.notEqual(app.state.code, previousCode);
      const invite = parseInvite(app.state.invite);
      const socket = net.createConnection(invite.endpoints[0]);
      await once(socket, "connect");
      guest = await SecureChannel.open(socket, false, invite);
      guest.send({ op: "CHANNEL", role: "PRIMARY", version: 1, epoch: 1 });
      assert.equal((await guest.receive()).ok, true);
      guest.send({ op: "SYNC", revision: "" });
      assert.equal((await guest.receive()).items.length, 1);
      guest.send({ op: "ADD", id: randomUUID(), videoId: "12345678901" });
      assert.equal((await guest.receive()).items.length, 2);
      await app.request({ type: "LOCK", allow: false });
      guest.send({ op: "ADD", id: randomUUID(), videoId: "aaaaaaaaaaa" });
      assert.match((await guest.receive()).error, /locked/);
      assert.equal((await app.request({ type: "END" })).ok, true);
      assert.equal(app.state.role, "Idle");
      await assert.rejects(guest.receive(), /closed/);
    } finally {
      guest?.close();
      await app.close();
    }
  },
);

test(
  "two native helpers join using LAN short-code discovery",
  { timeout: 45000 },
  async (context) => {
    if (!addresses().length)
      return context.skip("Requires a private LAN interface");
    const host = helper();
    const guest = helper();
    try {
      assert.equal((await host.request({ type: "HOST" })).ok, true);
      const response = await guest.request({
        type: "JOIN_CODE",
        code: host.state.code,
      });
      assert.equal(response.ok, true, response.error);
      assert.equal(guest.state.connected, true);
      const snapshot = await guest.request({
        type: "COMMAND",
        command: { op: "SNAPSHOT" },
      });
      assert.equal(snapshot.items[0].videoId, "abcdefghijk");
      assert.equal((await host.request({ type: "REFRESH_CODE" })).ok, true);
      assert.equal(
        (await guest.request({ type: "COMMAND", command: { op: "SNAPSHOT" } }))
          .items.length,
        1,
      );
    } finally {
      await guest.close();
      await host.close();
    }
  },
);

test(
  "native helper joins a host and preserves Android queue snapshots",
  { timeout: 15000 },
  async (context) => {
    const address = addresses()[0];
    if (!address) {
      context.skip("Requires a private LAN interface");
      return;
    }
    const server = net.createServer();
    server.listen(0, address);
    await once(server, "listening");
    const invite = createInvite([
      { host: address, port: server.address().port },
    ]);
    const accepted = once(server, "connection");
    const app = helper();
    let host;
    try {
      const joining = app.request({ type: "JOIN", invite: invite.uri });
      const [socket] = await accepted;
      host = await SecureChannel.open(socket, true, invite);
      assert.equal((await host.receive()).op, "CHANNEL");
      host.send({ ok: true, version: 1 });
      assert.equal((await joining).ok, true);
      const syncing = app.request({
        type: "COMMAND",
        command: { op: "SNAPSHOT" },
      });
      assert.equal((await host.receive()).op, "SNAPSHOT");
      const snapshot = {
        ok: true,
        revision: "android:12",
        items: [
          {
            id: "7001",
            videoId: "abcdefghijk",
            title: "Phone track",
            current: true,
          },
        ],
        autoplay: [],
      };
      host.send(snapshot);
      assert.deepEqual(await syncing, sanitizeResponse(snapshot));
      assert.equal(app.state.snapshot.revision, "android:12");
      await app.request({ type: "END" });
      assert.equal(app.state.role, "Idle");
    } finally {
      host?.close();
      server.close();
      await app.close();
    }
  },
);

test(
  "leaving cancels an incomplete authenticated connection without reviving the session",
  { timeout: 15000 },
  async (context) => {
    const address = addresses()[0];
    if (!address) {
      context.skip("Requires a private LAN interface");
      return;
    }
    const server = net.createServer();
    server.listen(0, address);
    await once(server, "listening");
    const invitation = createInvite([
      { host: address, port: server.address().port },
    ]);
    const accepted = once(server, "connection");
    const app = helper();
    let socket;
    try {
      const joining = app.request({ type: "JOIN", invite: invitation.uri });
      [socket] = await accepted;
      assert.equal((await app.request({ type: "END" })).ok, true);
      await joining;
      assert.equal(app.state.role, "Idle");
      assert.equal((await app.request({ type: "STATE" })).state.role, "Idle");
    } finally {
      socket?.destroy();
      server.close();
      await app.close();
    }
  },
);
