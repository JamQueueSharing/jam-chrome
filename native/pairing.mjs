import net from "node:net";
import dgram from "node:dgram";
import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { Bonjour } from "bonjour-service";
import {
  Frames,
  SecureChannel,
  localAddress,
  parseInvite,
  uuid,
} from "./protocol.mjs";
import { discoveryPacket } from "./network.mjs";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const pairingPort = 39549;
const anySession = "00000000-0000-0000-0000-000000000000";

export function normalizeCode(input) {
  const code = String(input || "")
    .replace(/[- ]/g, "")
    .toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code))
    throw Error("Enter the eight-character Jam code");
  return code;
}

export function generateCode() {
  return Array.from(
    { length: 8 },
    () => alphabet[randomInt(alphabet.length)],
  ).join("");
}

function writePipe(stream, value) {
  const data = Buffer.isBuffer(value)
    ? value
    : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  stream.write(Buffer.concat([header, data]));
}

/** Only the three public J-PAKE rounds go over the network. The key stays on the private pipe. */
export async function agree(frames, host, jam, code, signal) {
  if (signal.aborted) throw Error("Pairing cancelled");
  const libraries = [
    "jam-pairing.jar",
    "bcprov-jdk18on-1.83.jar",
    "json-20240303.jar",
  ];
  const classpath = libraries
    .map((name) => fileURLToPath(new URL(`lib/${name}`, import.meta.url)))
    .join(delimiter);
  const worker = spawn(
    process.env.JAM_JAVA || "java",
    ["-cp", classpath, "app.morphe.jam.companion.PairingWorker"],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const output = new Frames(worker.stdout);
  worker.on("error", () =>
    output.fail(
      Error(
        "Java 17 or newer is required for short-code pairing. Re-run the installer.",
      ),
    ),
  );
  worker.stdin.on("error", () => {});
  worker.stderr.resume();
  const cancel = () => {
    output.fail(Error("Pairing cancelled or timed out"));
    frames.stream.destroy();
    worker.kill();
  };
  signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(cancel, 12000);
  try {
    writePipe(worker.stdin, { host, jam, code: normalizeCode(code) });
    for (let round = 0; round < 3; round++) {
      const outgoing = await output.read(16384, 12000);
      frames.write(outgoing);
      writePipe(worker.stdin, await frames.read(16384, 12000));
    }
    const result = JSON.parse((await output.read(1024, 12000)).toString());
    const key = Buffer.from(result.key || "", "base64url");
    if (key.length !== 32) throw Error("Pairing failed");
    return key;
  } catch (error) {
    frames.stream.destroy();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
    worker.kill();
  }
}

export async function giveInvitation(
  socket,
  invite,
  code,
  signal,
  frames = new Frames(socket),
) {
  const key = await agree(frames, true, invite.jamId, code, signal);
  let secure;
  try {
    secure = await SecureChannel.open(
      socket,
      true,
      { ...invite, secret: key },
      undefined,
      frames,
    );
    secure.send({ invite: invite.uri });
    return frames;
  } finally {
    secure?.txKey.fill(0);
    secure?.rxKey.fill(0);
    key.fill(0);
  }
}

export async function takeInvitation(
  socket,
  jamId,
  code,
  signal,
  frames = new Frames(socket),
) {
  const key = await agree(frames, false, jamId, code, signal);
  let secure;
  try {
    secure = await SecureChannel.open(
      socket,
      false,
      { jamId, secret: key },
      randomUUID(),
      frames,
    );
    const value = await secure.receive();
    const invite = parseInvite(value.invite);
    if (invite.jamId !== jamId) {
      invite.secret.fill(0);
      throw Error("Invitation session changed");
    }
    return { invite, frames, socket };
  } finally {
    secure?.txKey.fill(0);
    secure?.rxKey.fill(0);
    key.fill(0);
  }
}

function validPacket(data) {
  return (
    data.length === 32 && data.readUInt32BE() === 0x4d4a5032 && data[4] === 2
  );
}

function packetSession(data) {
  const hex = data.subarray(6, 22).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function startPairing(invite, onHandoff) {
  const code = generateCode();
  const expires = Math.min(Date.now() + 10 * 60000, invite.expires);
  const abort = new AbortController();
  const sockets = new Set();
  let attempts = 0;
  let windowStarted = Date.now();
  let windowAttempts = 0;
  let closed = false;
  let mdns;
  let advertisement;
  let udp;
  let expiration;
  const server = net.createServer(async (socket) => {
    if (!localAddress(socket.remoteAddress) && socket.remoteAddress !== "127.0.0.1") { socket.destroy(); return; }
    const now = Date.now();
    if (now - windowStarted >= 60000) {
      windowStarted = now;
      windowAttempts = 0;
    }
    if (
      closed ||
      now >= expires ||
      attempts >= 32 ||
      windowAttempts >= 8 ||
      sockets.size >= 2
    ) {
      socket.destroy();
      return;
    }
    attempts++;
    windowAttempts++;
    sockets.add(socket);
    const cancelSocket = () => socket.destroy();
    abort.signal.addEventListener("abort", cancelSocket, { once: true });
    try {
      const frames = await giveInvitation(socket, invite, code, abort.signal);
      if (closed || Date.now() >= expires) throw Error("Code expired");
      sockets.delete(socket);
      abort.signal.removeEventListener("abort", cancelSocket);
      onHandoff(socket, frames);
    } catch {
      socket.destroy();
    } finally {
      sockets.delete(socket);
      abort.signal.removeEventListener("abort", cancelSocket);
    }
  });

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(expiration);
    abort.abort();
    for (const socket of sockets) socket.destroy();
    server.close();
    advertisement?.stop();
    mdns?.destroy();
    try {
      udp?.close();
    } catch {}
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", resolve);
    });
    server.on("error", close);
    const port = server.address().port;
    mdns = new Bonjour({}, () => {});
    advertisement = mdns.publish({
      name: `Jam-pair-${invite.jamId.slice(0, 8)}`,
      type: "morphepair",
      port,
      txt: { jam: invite.jamId, v: "1" },
    });
    advertisement.on("error", () => {});
    udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
    udp.on("error", () => {});
    let replies = 0;
    let replyWindow = Date.now();
    udp.on("message", (data, peer) => {
      if (Date.now() - replyWindow > 1000) {
        replyWindow = Date.now();
        replies = 0;
      }
      if (
        closed ||
        Date.now() >= expires ||
        ++replies > 32 ||
        !localAddress(peer.address) ||
        !validPacket(data) ||
        data[5] !== 1 ||
        data.readUInt16BE(30) !== 0
      )
        return;
      const jam = packetSession(data);
      if (jam !== anySession && jam !== invite.jamId) return;
      udp.send(
        discoveryPacket(invite.jamId, data.subarray(22, 30), port),
        peer.port,
        peer.address,
      );
    });
    udp.bind(pairingPort);
    expiration = setTimeout(close, expires - Date.now());
    return {
      code: `${code.slice(0, 4)}-${code.slice(4)}`,
      expires,
      port,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

export async function discoverPairing(signal) {
  if (signal.aborted) throw Error("Pairing cancelled");
  return new Promise((resolve, reject) => {
    const endpoints = new Map();
    const nonce = randomBytes(8);
    const udp = dgram.createSocket("udp4");
    const mdns = new Bonjour({}, () => {});
    function add(host, port, jamId) {
      if (
        endpoints.size >= 16 ||
        !localAddress(host) ||
        !uuid.test(jamId) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      )
        return;
      endpoints.set(`${host}:${port}:${jamId}`, { host, port, jamId });
    }
    const browser = mdns.find({ type: "morphepair" }, (service) => {
      if (String(service.txt?.v) !== "1") return;
      for (const address of service.addresses || [])
        add(address, service.port, String(service.txt.jam));
    });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      browser.stop();
      mdns.destroy();
      try {
        udp.close();
      } catch {}
      if (signal.aborted) reject(Error("Pairing cancelled"));
      else resolve([...endpoints.values()]);
    }
    const timer = setTimeout(finish, 2200);
    signal.addEventListener("abort", finish, { once: true });
    udp.on("error", () => {});
    udp.on("message", (data, peer) => {
      if (
        validPacket(data) &&
        data[5] === 2 &&
        data.subarray(22, 30).equals(nonce)
      )
        add(peer.address, data.readUInt16BE(30), packetSession(data));
    });
    udp.bind(0, () => {
      udp.setBroadcast(true);
      udp.send(
        discoveryPacket(anySession, nonce),
        pairingPort,
        "255.255.255.255",
        () => {},
      );
    });
  });
}

export async function joinCode(
  input,
  signal,
  trackSocket,
  find = discoverPairing,
) {
  const code = normalizeCode(input);
  const deadline = AbortSignal.timeout(30000);
  const lifetime = AbortSignal.any([signal, deadline]);
  const endpoints = await find(lifetime);
  for (const endpoint of endpoints) {
    if (lifetime.aborted) break;
    const socket = net.createConnection({
      host: endpoint.host,
      port: endpoint.port,
    });
    trackSocket(socket);
    const frames = new Frames(socket);
    const cancel = () => socket.destroy();
    lifetime.addEventListener("abort", cancel, { once: true });
    socket.setTimeout(12000, cancel);
    try {
      const result = await takeInvitation(
        socket,
        endpoint.jamId,
        code,
        lifetime,
        frames,
      );
      if (lifetime.aborted) {
        result.invite.secret.fill(0);
        throw Error("Pairing cancelled");
      }
      socket.setTimeout(0);
      return result;
    } catch {
      socket.destroy();
    } finally {
      lifetime.removeEventListener("abort", cancel);
    }
  }
  if (signal.aborted) throw Error("Pairing cancelled");
  throw Error(
    "Code not found or expired. Keep both devices on the same LAN, or scan the host QR invitation.",
  );
}
