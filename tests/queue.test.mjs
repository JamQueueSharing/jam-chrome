import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HostQueue } from "../native/queue.mjs";

test("adding a duplicate with a new native ID never reuses an existing occurrence", async () => {
  const items = [{ nativeId: "1", videoId: "abcdefghijk" }];
  const queue = new HostQueue(async () => ({ items, index: 0 }));
  const before = await queue.snapshot();
  items.push({ nativeId: "2", videoId: "abcdefghijk" });
  const after = await queue.snapshot();
  assert.equal(after.items[0].id, before.items[0].id);
  assert.notEqual(after.items[1].id, before.items[0].id);
});

function fixture() {
  let state = {
    items: ["abcdefghijk", "12345678901", "abcdefghijk"].map((videoId) => ({
      videoId,
    })),
    index: 0,
    position: 12000,
    duration: 180000,
    playing: true,
  };
  const commands = [];
  const queue = new HostQueue(async (command) => {
    if (command.op !== "READ") commands.push(command);
    if (command.op === "ADD" || command.op === "PLAY_NEXT")
      state.items.splice(
        command.op === "ADD" ? state.items.length : state.index + 1,
        0,
        { videoId: command.videoId },
      );
    if (command.op === "MOVE")
      state.items.splice(
        command.toIndex,
        0,
        state.items.splice(command.fromIndex, 1)[0],
      );
    if (command.op === "REMOVE") state.items.splice(command.index, 1);
    if (command.op === "PLAY") state.index = command.index;
    return structuredClone(state);
  });
  return { queue, commands };
}

test("duplicate videos retain distinct numeric occurrence IDs across reorder", async () => {
  const { queue } = fixture();
  const before = await queue.snapshot();
  assert.notEqual(before.items[0].id, before.items[2].id);
  assert.ok(
    before.items.every(
      (row) => /^\d+$/.test(row.id) && BigInt(row.id) < 2n ** 63n,
    ),
  );
  const result = await queue.request(
    {
      op: "MOVE",
      id: randomUUID(),
      revision: before.revision,
      item: before.items[2].id,
      target: before.items[1].id,
    },
    "guest",
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.items.map((row) => row.id),
    [before.items[0].id, before.items[2].id, before.items[1].id],
  );
  assert.equal(result.clock.position, 12000);
});

test("stale edits and guest lock do not touch the player", async () => {
  const { queue, commands } = fixture();
  const before = await queue.snapshot();
  const stale = await queue.request(
    {
      op: "REMOVE",
      id: randomUUID(),
      revision: "stale",
      item: before.items[0].id,
    },
    "guest",
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.snapshot.revision, before.revision);
  queue.allowGuestEdits = false;
  const locked = await queue.request(
    { op: "ADD", id: randomUUID(), videoId: "aaaaaaaaaaa" },
    "guest",
  );
  assert.match(locked.error, /locked/);
  assert.equal(commands.length, 0);
});

test("retrying a command is idempotent and reusing its ID with different data fails", async () => {
  const { queue, commands } = fixture();
  const request = { op: "ADD", id: randomUUID(), videoId: "aaaaaaaaaaa" };
  const first = await queue.request(request, "guest");
  assert.deepEqual(await queue.request(request, "guest"), first);
  assert.match(
    (await queue.request({ ...request, videoId: "bbbbbbbbbbb" }, "guest"))
      .error,
    /reused/,
  );
  assert.equal(commands.length, 1);
});

test("failed mutation is cached and never automatically replayed", async () => {
  let attempts = 0;
  const queue = new HostQueue(async (command) => {
    if (command.op !== "READ") {
      attempts++;
      throw Error("Outcome unknown");
    }
    return { items: [{ videoId: "abcdefghijk" }], index: 0 };
  });
  const command = { op: "ADD", id: randomUUID(), videoId: "aaaaaaaaaaa" };
  assert.equal((await queue.request(command, "guest")).ok, false);
  assert.equal((await queue.request(command, "guest")).ok, false);
  assert.equal(attempts, 1);
});
