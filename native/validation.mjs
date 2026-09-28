const videoId = /^[A-Za-z0-9_-]{11}$/;
const operations = new Set([
  "PING",
  "SYNC",
  "SNAPSHOT",
  "CHANNEL",
  "ADD",
  "PLAY_NEXT",
  "REMOVE",
  "MOVE",
  "PLAY",
  "SEEK",
  "SKIP_NEXT",
  "SKIP_PREVIOUS",
]);

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateCommand(command) {
  if (
    !isObject(command) ||
    !operations.has(command.op) ||
    JSON.stringify(command).length > 8192
  )
    throw Error("Invalid or oversized command");
  for (const field of ["id", "item", "target", "revision"]) {
    if (
      command[field] !== undefined &&
      (typeof command[field] !== "string" || command[field].length > 128)
    )
      throw Error(`Invalid ${field}`);
  }
  if (
    command.videoId !== undefined &&
    (typeof command.videoId !== "string" || !videoId.test(command.videoId))
  )
    throw Error("Invalid video ID");
  if (command.playing !== undefined && typeof command.playing !== "boolean")
    throw Error("Invalid playback state");
  if (command.lane !== undefined && ![0, 1].includes(command.lane))
    throw Error("Invalid queue lane");
  if (
    command.position !== undefined &&
    (!Number.isSafeInteger(command.position) || command.position < 0)
  )
    throw Error("Invalid position");
  return command;
}

function text(value, limit = 200) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function clock(value) {
  if (!isObject(value)) throw Error("Invalid host clock");
  const result = {
    generation: text(value.generation, 128),
    videoId: text(value.videoId, 11),
    playing: value.playing === true,
    playbackControl: value.playbackControl === true,
  };
  for (const field of [
    "sequence",
    "sampledAt",
    "age",
    "position",
    "duration",
    "speed",
  ]) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "number" ||
        !Number.isFinite(value[field]) ||
        value[field] < 0 ||
        value[field] > Number.MAX_SAFE_INTEGER)
    )
      throw Error("Invalid host clock");
    result[field] = value[field] ?? 0;
  }
  return result;
}

function snapshot(value) {
  if (
    !isObject(value) ||
    typeof value.revision !== "string" ||
    value.revision.length > 128 ||
    !Array.isArray(value.items) ||
    (value.autoplay !== undefined && !Array.isArray(value.autoplay))
  )
    throw Error("Invalid host queue");
  const ids = new Set();
  function rows(items) {
    if (items.length > 500)
      throw Error("Host queue exceeds 500 items per lane");
    return items.map((row) => {
      if (
        !isObject(row) ||
        typeof row.id !== "string" ||
        !/^\d{1,19}$/.test(row.id) ||
        BigInt(row.id) > 0x7fffffffffffffffn ||
        typeof row.videoId !== "string" ||
        !videoId.test(row.videoId) ||
        ids.has(row.id)
      )
        throw Error("Invalid or duplicate host queue item");
      ids.add(row.id);
      return {
        id: row.id,
        videoId: row.videoId,
        title: text(row.title),
        artist: text(row.artist),
        current: row.current === true,
        thumbnail: `https://i.ytimg.com/vi/${row.videoId}/hqdefault.jpg`,
      };
    });
  }
  return {
    ok: value.ok === true,
    revision: value.revision,
    items: rows(value.items),
    autoplay: rows(value.autoplay || []),
    ...(value.clock === undefined ? {} : { clock: clock(value.clock) }),
  };
}

// Whitelist data before forwarding an authenticated but potentially malicious host to Chrome.
export function sanitizeResponse(value) {
  if (!isObject(value) || typeof value.ok !== "boolean")
    throw Error("Invalid host response");
  const result = { ok: value.ok };
  for (const flag of ["unchanged", "confirmed", "dispatched"])
    if (typeof value[flag] === "boolean") result[flag] = value[flag];
  if (value.error !== undefined) result.error = text(value.error, 300);
  if (value.items !== undefined) Object.assign(result, snapshot(value));
  else if (value.clock !== undefined) result.clock = clock(value.clock);
  if (value.snapshot !== undefined) result.snapshot = snapshot(value.snapshot);
  return result;
}
