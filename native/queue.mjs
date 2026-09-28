import { randomBytes, randomUUID } from "node:crypto";
import { uuid } from "./protocol.mjs";
import { validateCommand } from "./validation.mjs";

export const videoId = /^[A-Za-z0-9_-]{11}$/;
export const failure = (error) => ({
  ok: false,
  error: error.message || String(error),
});

export class HostQueue {
  constructor(player) {
    this.player = player;
    this.generation = randomUUID();
    this.counter = 0;
    this.clockSequence = 0;
    this.nextId = BigInt(`0x${randomBytes(6).toString("hex")}`);
    this.items = [];
    this.nativeIds = new Map();
    this.results = new Map();
    this.allowGuestEdits = true;
    this.serial = Promise.resolve();
    this.pending = 0;
    this.resultBytes = 0;
  }
  exclusive(task) {
    if (this.pending >= 32)
      return Promise.reject(Error("Too many queued commands"));
    this.pending++;
    // Sampling and mutations share one order, including commands from different guests.
    const next = this.serial.then(task).finally(() => {
      this.pending--;
    });
    this.serial = next.catch(() => {});
    return next;
  }
  async snapshot(preferred) {
    const state = await this.player({ op: "READ" });
    if (
      !Array.isArray(state.items) ||
      state.items.length > 500 ||
      state.items.some((row) => !videoId.test(row.videoId))
    )
      throw Error("Invalid or oversized YouTube Music queue");
    const pools = new Map();
    for (const item of preferred || this.items) {
      if (!pools.has(item.videoId)) pools.set(item.videoId, []);
      pools.get(item.videoId).push(item);
    }
    const usedIds = new Set();
    function takeUnused(pool) {
      while (pool?.length) {
        const item = pool.shift();
        if (!usedIds.has(item.id)) return item.id;
      }
    }
    const items = state.items.map((row, index) => {
      let id =
        row.nativeId == null
          ? undefined
          : this.nativeIds.get(`${row.nativeId}:${row.videoId}`);
      if (!id && (preferred || row.nativeId == null))
        id = takeUnused(pools.get(row.videoId));
      if (!id || usedIds.has(id)) id = String(++this.nextId);
      usedIds.add(id);
      return {
        id,
        videoId: row.videoId,
        title: String(row.title || row.videoId).slice(0, 200),
        artist: String(row.artist || "").slice(0, 200),
        current: index === state.index,
        thumbnail: `https://i.ytimg.com/vi/${row.videoId}/hqdefault.jpg`,
      };
    });
    this.nativeIds = new Map(
      state.items.flatMap((row, index) =>
        row.nativeId == null
          ? []
          : [[`${row.nativeId}:${row.videoId}`, items[index].id]],
      ),
    );
    const signature = JSON.stringify(items);
    if (signature !== this.signature) {
      this.signature = signature;
      this.counter++;
    }
    this.items = items;
    this.value = {
      ok: true,
      revision: `${this.generation}:${this.counter}`,
      items,
      autoplay: [],
      clock: {
        generation: this.generation,
        sequence: ++this.clockSequence,
        sampledAt: Math.floor(performance.now()),
        age: 0,
        playbackControl: true,
        videoId: items[state.index]?.videoId || "",
        playing: !!state.playing,
        speed: 1,
        position: Math.max(0, Math.round(state.position || 0)),
        duration: Math.max(0, Math.round(state.duration || 0)),
      },
    };
    return structuredClone(this.value);
  }
  request(command, client, local = false) {
    try {
      validateCommand(command);
    } catch (error) {
      return Promise.resolve(failure(error));
    }
    return this.exclusive(async () => {
      if (command.op === "PING") return { ok: true };
      const snapshot = await this.snapshot();
      if (command.op === "SYNC" || command.op === "SNAPSHOT")
        return command.op === "SYNC" && command.revision === snapshot.revision
          ? { ok: true, unchanged: true, clock: snapshot.clock }
          : snapshot;
      if (!local && !this.allowGuestEdits)
        return failure("The host has locked guest edits");
      if (!uuid.test(command.id)) return failure("Invalid command id");
      const key = `${client}:${command.id}`,
        body = JSON.stringify(command);
      if (this.results.has(key)) {
        const cached = this.results.get(key);
        return cached.body === body
          ? cached.value
          : failure("Command id reused");
      }
      if (this.results.size >= 4096 || this.resultBytes >= 8 * 1048576)
        return failure("Session command limit reached; start a new session");
      let value;
      try {
        value = await this.mutate(command, snapshot);
      } catch (error) {
        value = failure(error);
      }
      this.results.set(key, { body, value });
      this.resultBytes +=
        Buffer.byteLength(body) + Buffer.byteLength(JSON.stringify(value));
      return value;
    });
  }
  async mutate(command, snapshot) {
    const rows = structuredClone(snapshot.items);
    const current = rows.findIndex((row) => row.current);
    let index = current;
    const from = rows.findIndex((row) => row.id === command.item);
    if (["REMOVE", "MOVE"].includes(command.op)) {
      if (command.revision !== snapshot.revision)
        return { ...failure("Queue changed; refresh and retry"), snapshot };
      if ((command.lane ?? 0) !== 0 || from < 0)
        throw Error("Queue item no longer exists");
      if (command.op === "REMOVE") {
        if (rows.length === 1)
          throw Error("The last playing track cannot be removed");
        rows.splice(from, 1);
        await this.player({
          op: "REMOVE",
          index: from,
          expectedVideos: snapshot.items.map((row) => row.videoId),
        });
      } else {
        const to = rows.findIndex((row) => row.id === command.target);
        if (to < 0) throw Error("Destination no longer exists");
        rows.splice(to, 0, rows.splice(from, 1)[0]);
        await this.player({
          op: "MOVE",
          fromIndex: from,
          toIndex: to,
          expectedVideos: snapshot.items.map((row) => row.videoId),
        });
      }
      index = rows.findIndex((row) => row.current);
      if (index < 0) index = Math.min(from, rows.length - 1);
    } else if (["ADD", "PLAY_NEXT"].includes(command.op)) {
      if (!videoId.test(command.videoId))
        throw Error("Invalid YouTube video ID");
      if (rows.length >= 500) throw Error("Queue exceeds 500-item Jam limit");
      const row = { id: String(++this.nextId), videoId: command.videoId };
      rows.splice(
        command.op === "PLAY_NEXT" ? Math.max(0, current + 1) : rows.length,
        0,
        row,
      );
      index = Math.max(0, current);
      await this.player({ op: command.op, videoId: command.videoId });
    } else if (command.op === "PLAY") {
      if (from < 0 || rows[from].videoId !== command.videoId)
        throw Error("Track is no longer in the host queue");
      await this.player({
        op: "PLAY",
        index: from,
        videoId: command.videoId,
        playing: command.playing ?? true,
      });
      return { ...(await this.snapshot()), confirmed: true };
    } else if (command.op === "SEEK") {
      if (
        snapshot.clock.videoId !== command.videoId ||
        !Number.isSafeInteger(command.position) ||
        command.position < 0
      )
        throw Error("Invalid seek or track changed");
      await this.player({
        op: "SEEK",
        videoId: command.videoId,
        position: Math.min(command.position, snapshot.clock.duration),
      });
      return { ...(await this.snapshot()), dispatched: true };
    } else if (["SKIP_NEXT", "SKIP_PREVIOUS"].includes(command.op)) {
      index = current + (command.op === "SKIP_NEXT" ? 1 : -1);
      if (!rows[index]) throw Error("No track in that direction");
      await this.player({
        op: "PLAY",
        index,
        videoId: rows[index].videoId,
        playing: true,
      });
      return { ...(await this.snapshot()), confirmed: true };
    } else throw Error("Unsupported operation");
    return { ...(await this.snapshot(rows)), confirmed: true };
  }
}
