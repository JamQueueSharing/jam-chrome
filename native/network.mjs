import net from "node:net";
import dgram from "node:dgram";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { localAddress, SecureChannel } from "./protocol.mjs";

export function addresses() {
  return [
    ...new Set(
      Object.values(os.networkInterfaces())
        .flat()
        .filter(
          (x) =>
            x && !x.internal && x.family === "IPv4" && localAddress(x.address),
        )
        .map((x) => x.address),
    ),
  ].slice(0, 4);
}
export function discoveryPacket(jamId, nonce, port = 0) {
  const data = Buffer.alloc(32);
  data.writeUInt32BE(0x4d4a5032);
  data[4] = 2;
  data[5] = port ? 2 : 1;
  Buffer.from(jamId.replaceAll("-", ""), "hex").copy(data, 6);
  nonce.copy(data, 22);
  data.writeUInt16BE(port, 30);
  return data;
}
function packetMatches(data, invite) {
  return (
    data.length === 32 &&
    data.readUInt32BE() === 0x4d4a5032 &&
    data[4] === 2 &&
    data
      .subarray(6, 22)
      .equals(Buffer.from(invite.jamId.replaceAll("-", ""), "hex"))
  );
}
export function advertise(invite, port) {
  const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
  let count = 0;
  const timer = setInterval(() => {
    count = 0;
  }, 1000);
  udp.on("error", () => {}); // Direct invitation hints still work when discovery is occupied.
  udp.on("message", (data, peer) => {
    if (
      ++count > 32 ||
      !localAddress(peer.address) ||
      !packetMatches(data, invite) ||
      data[5] !== 1 ||
      data.readUInt16BE(30) !== 0
    )
      return;
    udp.send(
      discoveryPacket(invite.jamId, data.subarray(22, 30), port),
      peer.port,
      peer.address,
    );
  });
  udp.bind(39548);
  return () => {
    clearInterval(timer);
    try {
      udp.close();
    } catch {}
  };
}
export async function discover(invite, signal) {
  if (signal.aborted) throw Error("Cancelled");
  return new Promise((resolve, reject) => {
    const udp = dgram.createSocket("udp4"),
      nonce = randomBytes(8),
      found = [];
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      try {
        udp.close();
      } catch {}
      if (signal.aborted) reject(Error("Cancelled"));
      else resolve(found);
    };
    const timer = setTimeout(finish, 1800);
    signal.addEventListener("abort", finish, { once: true });
    udp.on("error", finish);
    udp.on("message", (data, peer) => {
      if (
        found.length < 16 &&
        localAddress(peer.address) &&
        packetMatches(data, invite) &&
        data[5] === 2 &&
        data.subarray(22, 30).equals(nonce) &&
        data.readUInt16BE(30)
      ) {
        found.push({ host: peer.address, port: data.readUInt16BE(30) });
      }
    });
    udp.bind(0, () => {
      udp.setBroadcast(true);
      udp.send(
        discoveryPacket(invite.jamId, nonce),
        39548,
        "255.255.255.255",
        () => {},
      );
    });
  });
}
export async function connect(invite, identity, signal, trackSocket) {
  const tryEndpoints = async (endpoints) => {
    for (const endpoint of endpoints) {
      if (signal.aborted) throw Error("Cancelled");
      const socket = net.createConnection(endpoint);
      trackSocket(socket);
      const abort = () => socket.destroy();
      signal.addEventListener("abort", abort, { once: true });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => socket.destroy(Error("Connection timed out")),
            2500,
          );
          const cleanup = () => {
            clearTimeout(timer);
            socket.removeListener("error", fail);
            socket.removeListener("close", closed);
          };
          const fail = (error) => {
            cleanup();
            reject(error);
          };
          const closed = () => fail(Error("Connection closed"));
          socket.once("error", fail);
          socket.once("close", closed);
          socket.once("connect", () => {
            cleanup();
            resolve();
          });
        });
        const channel = await SecureChannel.open(
          socket,
          false,
          invite,
          identity,
        );
        if (signal.aborted) {
          channel.close();
          throw Error("Cancelled");
        }
        return channel;
      } catch {
        socket.destroy();
      } finally {
        signal.removeEventListener("abort", abort);
      }
    }
  };
  return (
    (await tryEndpoints(invite.endpoints)) ||
    (await tryEndpoints(await discover(invite, signal))) ||
    Promise.reject(
      Error("Host unreachable. Use a fresh invite on the same LAN."),
    )
  );
}
