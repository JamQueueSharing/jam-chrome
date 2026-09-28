import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { delimiter } from "node:path";
import { createInvite, SecureChannel } from "../native/protocol.mjs";
import {
  giveInvitation,
  takeInvitation,
  startPairing,
  joinCode,
  normalizeCode,
} from "../native/pairing.mjs";

test("short codes normalize and reject ambiguous characters", () => {
  assert.equal(normalizeCode("abcd-efgh"), "ABCDEFGH");
  assert.throws(() => normalizeCode("ABCD-1234"));
});

test("Android CodeExchange interoperates in both roles, including the same-socket Jam handoff", async (t) => {
  mkdirSync("test-output/pairing-test", { recursive: true });
  const libraries = [
    "native/lib/jam-pairing.jar",
    "native/lib/bcprov-jdk18on-1.83.jar",
    "native/lib/json-20240303.jar",
  ].join(delimiter);
  execFileSync("javac", [
    "-cp",
    libraries,
    "-d",
    "test-output/pairing-test",
    "tests/PairingPeer.java",
  ]);
  const invite = createInvite([{ host: "192.168.1.2", port: 12345 }]);
  const args = (role) => [
    "-cp",
    `test-output/pairing-test${delimiter}${libraries}`,
    "app.morphe.jam.companion.PairingPeer",
    role,
    invite.uri,
    "ABCDEFGH",
  ];
  const androidHost = spawn("java", args("host"));
  t.after(() => androidHost.kill());
  const exited = once(androidHost, "exit");
  const [port] = await once(androidHost.stdout, "data");
  const socket = net.createConnection(
    Number(port.toString().trim()),
    "127.0.0.1",
  );
  t.after(() => socket.destroy());
  const paired = await takeInvitation(
    socket,
    invite.jamId,
    "ABCDEFGH",
    AbortSignal.timeout(15000),
  );
  const client = await SecureChannel.open(
    socket,
    false,
    paired.invite,
    undefined,
    paired.frames,
  );
  client.send({ op: "PING" });
  assert.deepEqual(await client.receive(), { op: "PING" });
  client.close();
  assert.equal((await exited)[0], 0);

  const server = net.createServer();
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const connection = once(server, "connection");
  const androidClient = spawn("java", [
    ...args("client"),
    String(server.address().port),
  ]);
  t.after(() => androidClient.kill());
  const clientExit = once(androidClient, "exit");
  const reply = once(androidClient.stdout, "data");
  const [accepted] = await connection;
  t.after(() => accepted.destroy());
  const frames = await giveInvitation(
    accepted,
    invite,
    "ABCDEFGH",
    AbortSignal.timeout(15000),
  );
  const host = await SecureChannel.open(
    accepted,
    true,
    invite,
    undefined,
    frames,
  );
  assert.deepEqual(await host.receive(), { op: "PING" });
  host.send({ ok: true });
  assert.deepEqual(JSON.parse((await reply)[0].toString()), { ok: true });
  host.close();
  assert.equal((await clientExit)[0], 0);
});

test("pairing listener rejects wrong codes and hands off valid connections", async (t) => {
  const invite = createInvite([{ host: "192.168.1.2", port: 12345 }]);
  let handoffs = 0;
  const pairing = await startPairing(invite, (socket) => {
    handoffs++;
    socket.destroy();
  });
  t.after(() => pairing.close());
  const find = async () => [
    { host: "127.0.0.1", port: pairing.port, jamId: invite.jamId },
  ];
  const wrong = pairing.code.startsWith("A") ? "BBBBBBBB" : "AAAAAAAA";
  await assert.rejects(
    joinCode(wrong, AbortSignal.timeout(15000), () => {}, find),
  );
  assert.equal(handoffs, 0);
  const result = await joinCode(
    pairing.code,
    AbortSignal.timeout(15000),
    () => {},
    find,
  );
  assert.equal(result.invite.jamId, invite.jamId);
  result.socket.destroy();
  assert.equal(handoffs, 1);
});
