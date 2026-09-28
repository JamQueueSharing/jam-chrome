import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { randomUUID, randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Frames,
  SecureChannel,
  createInvite,
  parseInvite,
} from "../native/protocol.mjs";

test("invitations round-trip Android-compatible endpoint hints and reject invalid credentials", () => {
  const invite = createInvite([{ host: "192.168.1.5", port: 32123 }]);
  const parsed = parseInvite(invite.uri);
  assert.deepEqual(parsed.secret, invite.secret);
  assert.deepEqual(parsed.endpoints, invite.endpoints);
  assert.throws(() => parseInvite(invite.uri.replace("v=2", "v=3")));
  assert.throws(() => parseInvite(`${invite.uri}&jam=${randomUUID()}`));
  assert.throws(() => parseInvite(invite.uri, invite.expires + 1));
  assert.throws(() =>
    parseInvite(invite.uri.replace(/ep=.*/, "ep=CAgICA.443")),
  );
});

test("TCP framing accepts split records and rejects oversized frames", async () => {
  const stream = new PassThrough();
  const frames = new Frames(stream);
  const pending = frames.read();
  stream.write(Buffer.from([0, 0]));
  stream.write(Buffer.from([0, 3, 65]));
  stream.write(Buffer.from([66, 67]));
  assert.equal((await pending).toString(), "ABC");
  const rejected = frames.read();
  stream.write(Buffer.from([0, 32, 0, 0]));
  await assert.rejects(rejected, /frame size/);
});

async function pair(secretOverride) {
  const invite = { jamId: randomUUID(), secret: randomBytes(32) };
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const accepted = once(server, "connection");
  const clientSocket = net.createConnection(server.address().port, "127.0.0.1");
  const [hostSocket] = await accepted;
  await once(clientSocket, "connect");
  const channels = await Promise.allSettled([
    SecureChannel.open(hostSocket, true, invite).catch((error) => {
      hostSocket.destroy();
      throw error;
    }),
    SecureChannel.open(clientSocket, false, {
      ...invite,
      secret: secretOverride || invite.secret,
    }),
  ]);
  server.close();
  return { channels, hostSocket, clientSocket };
}

test("encrypted records authenticate both directions and reject replay", async () => {
  const { channels, hostSocket, clientSocket } = await pair();
  const [host, client] = channels.map((result) => result.value);
  try {
    client.send({ op: "PING" });
    assert.deepEqual(await host.receive(), { op: "PING" });
    host.send({ ok: true, title: "Song with accents: č" });
    assert.equal((await client.receive()).title, "Song with accents: č");
    client.sent = 0n;
    client.send({ op: "PING" });
    await assert.rejects(host.receive(), /Replay/);
  } finally {
    host.close();
    client.close();
    hostSocket.destroy();
    clientSocket.destroy();
  }
});

test("wrong invitation secret fails mutual authentication", async () => {
  const { channels, hostSocket, clientSocket } = await pair(randomBytes(32));
  hostSocket.destroy();
  clientSocket.destroy();
  assert.ok(channels.every((result) => result.status === "rejected"));
});

test("Node and the real Android SecureChannel interoperate in both roles", async () => {
  const output = fileURLToPath(
    new URL("../test-output/java/", import.meta.url),
  );
  const source = fileURLToPath(
    new URL(
      "../native/java/android/",
      import.meta.url,
    ),
  );
  mkdirSync(output, { recursive: true });
  execFileSync("javac", [
    "-d",
    output,
    `${source}/ChannelTransport.java`,
    `${source}/SocketChannelTransport.java`,
    `${source}/SecureChannel.java`,
    fileURLToPath(new URL("ProtocolPeer.java", import.meta.url)),
  ]);
  const invite = { jamId: randomUUID(), secret: randomBytes(32) };
  const argumentsFor = (role) => [
    "-cp",
    output,
    "app.morphe.jam.companion.ProtocolPeer",
    role,
    invite.jamId,
    invite.secret.toString("base64url"),
    randomUUID(),
  ];
  const androidHost = spawn("java", argumentsFor("host"));
  const hostExit = once(androidHost, "exit");
  const [data] = await once(androidHost.stdout, "data");
  const socket = net.createConnection(
    Number(data.toString().trim()),
    "127.0.0.1",
  );
  await once(socket, "connect");
  const client = await SecureChannel.open(socket, false, invite);
  client.send({ op: "SYNC", revision: "browser:1" });
  assert.deepEqual(await client.receive(), {
    op: "SYNC",
    revision: "browser:1",
  });
  client.close();
  assert.equal((await hostExit)[0], 0);

  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const connection = once(server, "connection");
  const androidClient = spawn("java", [
    ...argumentsFor("client"),
    String(server.address().port),
  ]);
  const clientExit = once(androidClient, "exit");
  const reply = once(androidClient.stdout, "data");
  const [accepted] = await connection;
  const host = await SecureChannel.open(accepted, true, invite);
  assert.deepEqual(await host.receive(), { op: "PING", from: "android" });
  host.send({ ok: true, from: "chrome" });
  assert.deepEqual(JSON.parse((await reply)[0].toString()), {
    ok: true,
    from: "chrome",
  });
  host.close();
  server.close();
  assert.equal((await clientExit)[0], 0);
});
