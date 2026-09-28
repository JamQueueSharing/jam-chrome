import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  Frames,
  LIMIT,
  createInvite,
  parseInvite,
} from "../native/protocol.mjs";
import { validateCommand, sanitizeResponse } from "../native/validation.mjs";
import { HostQueue } from "../native/queue.mjs";

test("malformed commands cannot reach the player", async () => {
  const queue = new HostQueue(() => {
    throw Error("Player must not be called");
  });
  for (const command of [
    null,
    [],
    { op: "EXEC" },
    { op: "PLAY", playing: "false" },
    { op: "ADD", videoId: "../bad/path" },
    { op: "SEEK", position: -1 },
    { op: "MOVE", revision: "x".repeat(9000) },
  ]) {
    assert.throws(() => validateCommand(command));
    assert.equal((await queue.request(command, "client")).ok, false);
  }
});

test("untrusted snapshots have bounded rows and safe metadata", () => {
  const value = {
    ok: true,
    revision: "r:1",
    items: [
      {
        id: "1",
        videoId: "abcdefghijk",
        title: "x".repeat(1000),
        thumbnail: "https://evil.invalid/track",
        injected: true,
      },
    ],
    autoplay: [],
    extra: "secret",
  };
  const clean = sanitizeResponse(value);
  assert.equal(clean.items[0].title.length, 200);
  assert.equal(
    clean.items[0].thumbnail,
    "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
  );
  assert.equal(clean.extra, undefined);
  assert.equal(clean.items[0].injected, undefined);
  assert.throws(
    () => sanitizeResponse({ ...value, autoplay: value.items }),
    /duplicate/,
  );
  assert.throws(() =>
    sanitizeResponse({ ...value, items: Array(501).fill(value.items[0]) }),
  );
  assert.throws(() => sanitizeResponse({ ok: true, clock: { position: -1 } }));
});

test("frame headers exceeding the current handshake limit fail before their body arrives", async () => {
  const stream = new PassThrough();
  const frames = new Frames(stream);
  const pending = frames.read(128);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(1024);
  stream.write(header);
  await assert.rejects(pending, /limit/);
  assert.equal(stream.destroyed, true);
});

test("queued frames have an aggregate byte budget", () => {
  const stream = new PassThrough();
  const frames = new Frames(stream);
  const frame = Buffer.alloc(LIMIT + 4);
  frame.writeUInt32BE(LIMIT);
  stream.write(frame);
  stream.write(frame);
  assert.match(frames.error.message, /limit/);
  assert.equal(frames.queuedBytes, 0);
});

test("invitations reject credentials and misleading URL components", () => {
  const invite = createInvite([{ host: "192.168.1.2", port: 1234 }]);
  for (const value of [
    invite.uri.replace("//join", "//user@join"),
    `${invite.uri}#fragment`,
    invite.uri.replace("join?", "join/path?"),
  ])
    assert.throws(() => parseInvite(value));
});

test("pending queue operations are bounded", async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const queue = new HostQueue(() => {});
  const waiting = Array.from({ length: 32 }, () =>
    queue.exclusive(() => blocked),
  );
  await assert.rejects(
    queue.exclusive(() => {}),
    /Too many/,
  );
  release();
  await Promise.all(waiting);
  assert.equal(queue.pending, 0);
});
