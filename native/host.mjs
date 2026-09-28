import net from "node:net";
import { randomUUID } from "node:crypto";
import {
  Frames,
  SecureChannel,
  createInvite,
  parseInvite,
  localAddress,
} from "./protocol.mjs";
import { HostQueue, failure } from "./queue.mjs";
import { addresses, advertise, connect } from "./network.mjs";
import { startPairing, joinCode, normalizeCode } from "./pairing.mjs";
import { isObject, validateCommand, sanitizeResponse } from "./validation.mjs";

const input = new Frames(process.stdin, true);
const pendingPlayerRequests = new Map();
let session = null;
let pendingNativeRequests = 0;

function send(message) {
  const data = Buffer.from(JSON.stringify(message));
  if (data.length > 1048576 || process.stdout.writableLength > 2097152) {
    process.exit(1);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  process.stdout.write(Buffer.concat([header, data]));
}

function playerRequest(owner, command) {
  if (session !== owner) return Promise.reject(Error("Session ended"));
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pendingPlayerRequests.delete(requestId);
      reject(
        Error(
          "Player timed out; outcome unknown. Refresh before another edit.",
        ),
      );
    }, 20000);
    pendingPlayerRequests.set(requestId, { resolve, reject, timer, owner });
    send({ type: "player", requestId, command });
  });
}

function publish(owner, error = "") {
  if (owner && owner !== session) return;
  const state = owner
    ? {
        role: owner.role,
        connected: owner.role === "Host" || !!owner.channel,
        peers: new Set([...owner.peers.values()].map((peer) => peer.clientId))
          .size,
        allowGuestEdits: owner.queue?.allowGuestEdits ?? true,
        invite: owner.role === "Host" ? owner.invite?.uri : "",
        code: owner.pairing?.code,
        codeExpires: owner.pairing?.expires,
        snapshot: owner.snapshot,
        error,
      }
    : { role: "Idle", connected: false, peers: 0, error };
  send({ type: "state", state });
  return state;
}

function endSession() {
  const old = session;
  session = null;
  if (old) {
    old.abort.abort();
    clearTimeout(old.timer);
    clearTimeout(old.expiration);
    old.stopDiscovery?.();
    old.pairing?.close();
    old.server?.close();
    old.channel?.close();
    for (const socket of old.sockets) socket.destroy();
    old.invite?.secret.fill(0);
    for (const [id, pending] of pendingPlayerRequests) {
      if (pending.owner === old) {
        clearTimeout(pending.timer);
        pending.reject(Error("Session ended"));
        pendingPlayerRequests.delete(id);
      }
    }
  }
  publish(null);
}

function newSession(role) {
  if (session) throw Error("Leave the current Jam first");
  endSession();
  session = {
    role,
    identity: randomUUID(),
    epoch: 0,
    abort: new AbortController(),
    peers: new Map(),
    authorities: new Map(),
    sockets: new Set(),
    serial: Promise.resolve(),
    pendingCommands: 0,
  };
  return session;
}

function trackSocket(owner, socket) {
  owner.sockets.add(socket);
  socket.once("close", () => owner.sockets.delete(socket));
}

function expireSession(owner) {
  owner.expiration = setTimeout(
    () => {
      if (session === owner) endSession();
    },
    Math.max(0, owner.invite.expires - Date.now()),
  );
}

async function serveGuest(owner, socket, frames) {
  let peer;
  try {
    peer = await SecureChannel.open(
      socket,
      true,
      owner.invite,
      undefined,
      frames,
    );
    if (session !== owner) return;
    owner.peers.set(socket, peer);
    publish(owner);
    while (session === owner) {
      const command = validateCommand(await peer.receive());
      let response;
      if (command.op === "CHANNEL") {
        const previous = owner.authorities.get(peer.clientId);
        if (!previous && owner.authorities.size >= 128)
          throw Error("Session identity limit reached");
        let allowed = command.version === 1 && command.role === "BACKUP";
        if (
          command.version === 1 &&
          command.role === "PRIMARY" &&
          Number.isSafeInteger(command.epoch) &&
          command.epoch > (previous?.epoch || 0) &&
          !peer.retired
        ) {
          if (previous?.peer && previous.peer !== peer)
            previous.peer.retired = true;
          owner.authorities.set(peer.clientId, { epoch: command.epoch, peer });
          allowed = true;
        }
        response = { ok: allowed, version: 1 };
      } else if (
        !["PING", "SYNC", "SNAPSHOT"].includes(command.op) &&
        owner.authorities.has(peer.clientId) &&
        owner.authorities.get(peer.clientId).peer !== peer
      ) {
        response = failure("Channel is not primary");
      } else {
        response = await owner.queue.request(command, peer.clientId);
        owner.snapshot = owner.queue.value;
        publish(owner);
      }
      if (session !== owner) break;
      peer.send(response);
    }
  } catch {
    // Authentication errors and malformed records close only this connection.
  } finally {
    peer?.close();
    socket.destroy();
    owner.peers.delete(socket);
    publish(owner);
  }
}

async function startHost() {
  const localAddresses = addresses();
  if (!localAddresses.length)
    throw Error("Connect to a private Wi-Fi or Ethernet network first");
  const owner = newSession("Host");
  owner.queue = new HostQueue((command) => playerRequest(owner, command));
  try {
    owner.snapshot = await owner.queue.snapshot();
    if (session !== owner) return;
    if (!owner.snapshot.items.length)
      throw Error("Play a song in YouTube Music before starting a Jam");
    owner.server = net.createServer((socket) => {
      if (
        session !== owner ||
        owner.sockets.size >= 8 ||
        !owner.invite ||
        !localAddress(socket.remoteAddress)
      ) {
        socket.destroy();
        return;
      }
      trackSocket(owner, socket);
      void serveGuest(owner, socket);
    });
    await new Promise((resolve, reject) => {
      owner.server.once("error", reject);
      owner.server.listen(0, "0.0.0.0", resolve);
    });
    if (session !== owner) {
      owner.server.close();
      return;
    }
    owner.server.on("error", (error) => {
      if (session === owner) {
        endSession();
        publish(null, error.message);
      }
    });
    const port = owner.server.address().port;
    owner.invite = createInvite(localAddresses.map((host) => ({ host, port })));
    owner.stopDiscovery = advertise(owner.invite, port);
    await refreshCode(owner);
    if (session !== owner) return;
    expireSession(owner);
    publish(owner);
    schedulePoll(owner);
  } catch (error) {
    if (session === owner) endSession();
    throw error;
  }
}

async function refreshCode(owner) {
  if (owner.refreshingCode) throw Error("A new code is already being created");
  owner.refreshingCode = true;
  owner.pairing?.close();
  try {
    const pairing = await startPairing(owner.invite, (socket, frames) => {
      if (session !== owner || owner.sockets.size >= 8) return socket.destroy();
      trackSocket(owner, socket);
      void serveGuest(owner, socket, frames);
    });
    if (session !== owner) {
      pairing.close();
      return;
    }
    owner.pairing = pairing;
    publish(owner);
  } finally {
    owner.refreshingCode = false;
  }
}

async function joinShortCode(code) {
  normalizeCode(code);
  const owner = newSession("Participant");
  publish(owner);
  try {
    const paired = await joinCode(code, owner.abort.signal, (socket) =>
      trackSocket(owner, socket),
    );
    if (session !== owner) {
      paired.socket.destroy();
      paired.invite.secret.fill(0);
      return;
    }
    owner.invite = paired.invite;
    expireSession(owner);
    owner.channel = await SecureChannel.open(
      paired.socket,
      false,
      owner.invite,
      owner.identity,
      paired.frames,
    );
    if (session !== owner) {
      owner.channel.close();
      return;
    }
    await claimPrimary(owner);
    publish(owner);
    schedulePoll(owner);
  } catch (error) {
    if (session === owner) endSession();
    throw error;
  }
}

async function join(invitation) {
  const invite = parseInvite(invitation);
  const owner = newSession("Participant");
  owner.invite = invite;
  expireSession(owner);
  publish(owner);
  // Connection runs separately so leaving can cancel an in-flight handshake.
  await reconnect(owner);
  if (session === owner) schedulePoll(owner);
}

async function reconnect(owner) {
  try {
    owner.channel = await connect(
      owner.invite,
      owner.identity,
      owner.abort.signal,
      (socket) => trackSocket(owner, socket),
    );
    if (session !== owner) {
      owner.channel.close();
      return;
    }
    await claimPrimary(owner);
    publish(owner);
  } catch (error) {
    owner.channel?.close();
    owner.channel = null;
    publish(owner, error.message);
  }
}

async function claimPrimary(owner) {
  owner.channel.send({
    op: "CHANNEL",
    version: 1,
    role: "PRIMARY",
    epoch: ++owner.epoch,
  });
  const response = await owner.channel.receive();
  // Older Android hosts have no CHANNEL operation and allow the legacy connection.
  if (!response.ok && response.error !== "Unsupported operation")
    throw Error("Host rejected the primary channel");
}

function serialRequest(owner, task) {
  if (owner.pendingCommands >= 32)
    return Promise.reject(Error("Too many queued commands"));
  owner.pendingCommands++;
  const result = owner.serial.then(() => {
    if (session !== owner) throw Error("Session ended");
    return task();
  });
  const finished = result.finally(() => {
    owner.pendingCommands--;
  });
  owner.serial = finished.catch(() => {});
  return finished;
}

async function remoteRequest(owner, command) {
  if (!owner.channel)
    throw Error("Disconnected; wait for reconnection before editing");
  try {
    owner.channel.send(command);
    const response = sanitizeResponse(await owner.channel.receive());
    if (response.items) owner.snapshot = response;
    else if (response.snapshot) owner.snapshot = response.snapshot;
    else if (response.clock && owner.snapshot)
      owner.snapshot.clock = response.clock;
    publish(owner);
    return response;
  } catch (error) {
    owner.channel?.close();
    owner.channel = null;
    publish(owner, "Disconnected; last command outcome may be unknown.");
    throw error;
  }
}

function schedulePoll(owner) {
  owner.timer = setTimeout(
    async () => {
      try {
        await serialRequest(owner, async () => {
          if (owner.role === "Host") {
            owner.snapshot = await owner.queue.request(
              { op: "SNAPSHOT" },
              owner.identity,
              true,
            );
            publish(owner);
          } else {
            if (!owner.channel) await reconnect(owner);
            if (owner.channel)
              await remoteRequest(owner, {
                op: "SYNC",
                revision: owner.snapshot?.revision || "",
              });
          }
        });
      } catch (error) {
        publish(owner, error.message);
      }
      if (session === owner) schedulePoll(owner);
    },
    owner.role === "Participant" && !owner.channel ? 3000 : 1000,
  );
}

async function handle(message) {
  if (message.type === "HOST") {
    await startHost();
    return { ok: true };
  }
  if (message.type === "JOIN") {
    await join(message.invite);
    return { ok: true };
  }
  if (message.type === "JOIN_CODE") {
    await joinShortCode(message.code);
    return { ok: true };
  }
  if (message.type === "END") {
    endSession();
    return { ok: true };
  }
  if (message.type === "STATE") return { ok: true, state: publish(session) };
  const owner = session;
  if (!owner) throw Error("No active Jam");
  if (message.type === "REFRESH_CODE" && owner.role === "Host") {
    await refreshCode(owner);
    return { ok: true };
  }
  if (message.type === "LOCK" && owner.role === "Host") {
    owner.queue.allowGuestEdits = message.allow === true;
    publish(owner);
    return { ok: true };
  }
  if (message.type !== "COMMAND") throw Error("Unsupported request");
  validateCommand(message.command);
  return serialRequest(owner, async () => {
    if (owner.role === "Participant")
      return remoteRequest(owner, message.command);
    const response = await owner.queue.request(
      message.command,
      owner.identity,
      true,
    );
    owner.snapshot = owner.queue.value;
    publish(owner);
    return response;
  });
}

function shutdown() {
  endSession();
  process.exit(0);
}

process.stdout.on("error", () => process.exit(1));
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);

try {
  while (true) {
    const message = JSON.parse(
      (await input.read(1048576, 24 * 3600000)).toString("utf8"),
    );
    if (!isObject(message) || typeof message.type !== "string")
      throw Error("Invalid native request");
    if (message.type === "playerResult") {
      const pending = pendingPlayerRequests.get(message.requestId);
      if (pending) {
        pendingPlayerRequests.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(Error(message.error));
        else pending.resolve(message.result);
      }
      continue;
    }
    if (
      pendingNativeRequests >= 32 ||
      typeof message.requestId !== "string" ||
      message.requestId.length > 128 ||
      JSON.stringify(message).length > 16384
    )
      throw Error("Too many pending requests");
    pendingNativeRequests++;
    void handle(message)
      .then(
        (result) => send({ requestId: message.requestId, result }),
        (error) =>
          send({ requestId: message.requestId, result: failure(error) }),
      )
      .finally(() => {
        pendingNativeRequests--;
      });
  }
} catch {
  shutdown();
}
