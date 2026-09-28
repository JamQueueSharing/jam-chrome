import net from "node:net";
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

export const LIMIT = 1048576;
export const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const utf = (value) => Buffer.from(value, "utf8");
const cat = (...values) => Buffer.concat(values);
const mac = (key, ...data) =>
  createHmac("sha256", key)
    .update(cat(...data))
    .digest();
const equal = (a, b) => a.length === b.length && timingSafeEqual(a, b);

export function localAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return net.isIP(address) === 6 && /^(f[cd]|fe[89ab])/i.test(address);
}

export function parseInvite(value, now = Date.now()) {
  if (typeof value !== "string" || value.length > 1024)
    throw Error("Invalid invitation");
  const url = new URL(value.trim());
  const p = url.searchParams;
  if (
    url.protocol !== "morphejam:" ||
    url.hostname !== "join" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    (url.pathname && url.pathname !== "/") ||
    !["1", "2"].includes(p.get("v")) ||
    [...p.keys()].length !== new Set(p.keys()).size ||
    !uuid.test(p.get("jam"))
  )
    throw Error("Invalid invitation");
  const encoded = p.get("secret") || "";
  const secret = Buffer.from(encoded, "base64url");
  const expires = Number(p.get("exp"));
  if (
    secret.length !== 32 ||
    secret.toString("base64url") !== encoded ||
    !Number.isSafeInteger(expires) ||
    expires <= now ||
    expires > now + 13 * 3600000
  )
    throw Error("Expired or invalid invitation");
  const endpoints = [];
  if (p.get("v") === "2" && p.has("ep")) {
    const hints = p.get("ep").split(",");
    if (hints.length > 4) throw Error("Too many endpoint hints");
    for (const hint of hints) {
      const parts = hint.split(".");
      const bytes = Buffer.from(parts[0], "base64url");
      const port = Number(parts[1]);
      const address =
        bytes.length === 4
          ? [...bytes].join(".")
          : bytes.length === 16
            ? Array.from({ length: 8 }, (_, i) =>
                bytes.readUInt16BE(i * 2).toString(16),
              ).join(":")
            : "";
      if (
        parts.length !== 2 ||
        bytes.toString("base64url") !== parts[0] ||
        !localAddress(address) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      )
        throw Error("Invalid endpoint hint");
      endpoints.push({ host: address, port });
    }
  }
  return { jamId: p.get("jam"), secret, expires, endpoints };
}

export function createInvite(endpoints) {
  const invite = {
    jamId: randomUUID(),
    secret: randomBytes(32),
    expires: Date.now() + 12 * 3600000,
    endpoints,
  };
  const hints = endpoints
    .slice(0, 4)
    .map(
      ({ host, port }) =>
        `${Buffer.from(host.split(".").map(Number)).toString("base64url")}.${port}`,
    );
  invite.uri = `morphejam://join?v=2&jam=${invite.jamId}&secret=${invite.secret.toString("base64url")}&exp=${invite.expires}&ep=${hints.join(",")}`;
  return invite;
}

// TCP uses big-endian framing; Chrome's stdio framing is little-endian on Windows.
export class Frames {
  constructor(stream, littleEndian = false) {
    this.stream = stream;
    this.littleEndian = littleEndian;
    this.buffer = Buffer.alloc(0);
    this.frames = [];
    this.queuedBytes = 0;
    this.waiter = null;
    stream.on("data", (data) => {
      try {
        if (this.error) return;
        if (this.queuedBytes + this.buffer.length + data.length > 2 * LIMIT)
          throw Error("Buffered data limit exceeded");
        this.buffer = cat(this.buffer, data);
        while (this.buffer.length >= 4) {
          const size = littleEndian
            ? this.buffer.readUInt32LE()
            : this.buffer.readUInt32BE();
          if (size < 1 || size > LIMIT) throw Error("Invalid frame size");
          if (this.waiter && size > this.waiter.max)
            throw Error("Frame exceeds limit");
          if (this.buffer.length < size + 4) break;
          this.frames.push(Buffer.from(this.buffer.subarray(4, size + 4)));
          this.queuedBytes += size;
          this.buffer = this.buffer.subarray(size + 4);
          if (this.frames.length > 32) throw Error("Too many queued frames");
          this.drain();
        }
      } catch (error) {
        this.frames = [];
        this.buffer = Buffer.alloc(0);
        this.queuedBytes = 0;
        this.fail(error);
        stream.destroy();
      }
    });
    stream.on("error", (error) => this.fail(error));
    stream.on("end", () => this.fail(Error("Connection closed")));
    stream.on("close", () => this.fail(Error("Connection closed")));
  }
  fail(error) {
    this.error ||= error;
    this.drain();
  }
  drain() {
    if (!this.waiter) return;
    if (this.error || this.frames.length) {
      const { resolve, reject, timer } = this.waiter;
      this.waiter = null;
      clearTimeout(timer);
      // A peer may close immediately after sending its final complete record.
      if (this.frames.length) {
        const data = this.frames.shift();
        this.queuedBytes -= data.length;
        resolve(data);
      } else reject(this.error);
    }
  }
  async read(max = LIMIT, timeout = 45000) {
    if (this.waiter) throw Error("Concurrent reads");
    const data = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(Error("Connection timed out"));
        this.stream.destroy();
      }, timeout);
      this.waiter = { resolve, reject, timer, max };
      this.drain();
    });
    if (data.length > max) throw Error("Frame exceeds limit");
    return data;
  }
  write(data) {
    if (this.error) throw this.error;
    if (data.length < 1 || data.length > LIMIT)
      throw Error("Frame exceeds limit");
    if (this.stream.writableLength > 2 * LIMIT)
      throw Error("Connection too slow");
    const prefix = Buffer.alloc(4);
    if (this.littleEndian) prefix.writeUInt32LE(data.length);
    else prefix.writeUInt32BE(data.length);
    this.stream.write(cat(prefix, data));
  }
}

export class SecureChannel {
  static async open(socket, host, invite, identity = randomUUID(), frames) {
    const channel = new SecureChannel();
    channel.socket = socket;
    channel.frames = frames || new Frames(socket);
    socket.setNoDelay(true);
    const { jamId, secret } = invite;
    const prefix = utf(`MORPHEJAM/1:${jamId}:`);
    let hostNonce, clientNonce, transcript;
    if (host) {
      hostNonce = randomBytes(32);
      channel.frames.write(cat(prefix, hostNonce));
      const hello = await channel.frames.read(128, 15000);
      if (hello.length !== 100) throw Error("Invalid client hello");
      clientNonce = hello.subarray(0, 32);
      identity = hello.subarray(32, 68).toString("ascii");
      if (!uuid.test(identity)) throw Error("Invalid client identity");
      transcript = cat(
        utf(`MORPHEJAM/1:${jamId}:${identity}`),
        hostNonce,
        clientNonce,
      );
      if (!equal(hello.subarray(68), mac(secret, utf("client"), transcript)))
        throw Error("Authentication failed");
      channel.frames.write(mac(secret, utf("host"), transcript));
    } else {
      if (!uuid.test(identity)) throw Error("Invalid client identity");
      const challenge = await channel.frames.read(128, 15000);
      if (
        challenge.length !== prefix.length + 32 ||
        !equal(prefix, challenge.subarray(0, prefix.length))
      )
        throw Error("Session mismatch");
      hostNonce = challenge.subarray(prefix.length);
      clientNonce = randomBytes(32);
      transcript = cat(
        utf(`MORPHEJAM/1:${jamId}:${identity}`),
        hostNonce,
        clientNonce,
      );
      channel.frames.write(
        cat(clientNonce, utf(identity), mac(secret, utf("client"), transcript)),
      );
      if (
        !equal(
          await channel.frames.read(32, 15000),
          mac(secret, utf("host"), transcript),
        )
      )
        throw Error("Host authentication failed");
    }
    const prk = mac(cat(hostNonce, clientNonce), secret);
    const clientKey = mac(
      prk,
      utf(`morphejam-v1-client:${jamId}${identity}`),
      Buffer.from([1]),
    );
    const hostKey = mac(
      prk,
      utf(`morphejam-v1-host:${jamId}${identity}`),
      Buffer.from([1]),
    );
    prk.fill(0);
    channel.txKey = host ? hostKey : clientKey;
    channel.rxKey = host ? clientKey : hostKey;
    channel.txDirection = host ? 2 : 1;
    channel.rxDirection = host ? 1 : 2;
    channel.clientId = identity;
    channel.sent = channel.received = 0n;
    return channel;
  }
  nonce(direction, sequence) {
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(direction);
    nonce.writeBigUInt64BE(sequence, 4);
    return nonce;
  }
  send(value) {
    const plain = utf(JSON.stringify(value));
    if (plain.length > LIMIT - 24 || this.sent >= 0x7fffffffffffffffn)
      throw Error("Frame limit");
    const sequence = ++this.sent;
    const nonce = this.nonce(this.txDirection, sequence);
    const cipher = createCipheriv("aes-256-gcm", this.txKey, nonce);
    cipher.setAAD(cat(utf("morphejam/1"), nonce));
    this.frames.write(
      cat(
        nonce.subarray(4),
        cipher.update(plain),
        cipher.final(),
        cipher.getAuthTag(),
      ),
    );
  }
  async receive() {
    const frame = await this.frames.read();
    if (frame.length < 24) throw Error("Truncated record");
    const sequence = frame.readBigUInt64BE();
    if (sequence !== this.received + 1n || sequence > 0x7fffffffffffffffn)
      throw Error("Replay or sequence gap");
    const nonce = this.nonce(this.rxDirection, sequence);
    const cipher = createDecipheriv("aes-256-gcm", this.rxKey, nonce);
    cipher.setAAD(cat(utf("morphejam/1"), nonce));
    cipher.setAuthTag(frame.subarray(-16));
    const plain = cat(cipher.update(frame.subarray(8, -16)), cipher.final());
    this.received = sequence;
    return JSON.parse(plain.toString("utf8"));
  }
  close() {
    this.txKey.fill(0);
    this.rxKey.fill(0);
    this.socket.destroy();
  }
}
