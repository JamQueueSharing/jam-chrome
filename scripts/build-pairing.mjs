import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const directory = new URL("../native/lib/", import.meta.url);
await mkdir(directory, { recursive: true });
const dependencies = [
  [
    "bcprov-jdk18on-1.83.jar",
    "org/bouncycastle/bcprov-jdk18on/1.83",
    "82cf3a2af766c3bc874f6d36b9f20a8b99a8f09762dc776e8a227a45d8daaafb",
  ],
  [
    "json-20240303.jar",
    "org/json/json/20240303",
    "3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed",
  ],
];
for (const [filename, path, hash] of dependencies) {
  const destination = new URL(filename, directory);
  let bytes;
  try {
    bytes = await readFile(destination);
  } catch {
    const response = await fetch(
      `https://repo.maven.apache.org/maven2/${path}/${filename}`,
    );
    if (!response.ok) throw Error(`Download failed: ${filename}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash("sha256").update(bytes).digest("hex") !== hash)
    throw Error(`Checksum mismatch: ${filename}`);
  await writeFile(destination, bytes);
}
const classes = fileURLToPath(
  new URL("../test-output/pairing-classes/", import.meta.url),
);
await mkdir(classes, { recursive: true });
const android = new URL(
  "../native/java/android/",
  import.meta.url,
);
const sources = [
  "ChannelTransport",
  "SocketChannelTransport",
  "SecureChannel",
  "Invitation",
  "CodeExchange",
].map((name) => fileURLToPath(new URL(`${name}.java`, android)));
const classpath = dependencies
  .map(([filename]) => fileURLToPath(new URL(filename, directory)))
  .join(delimiter);
execFileSync("javac", [
  "--release",
  "17",
  "-cp",
  classpath,
  "-d",
  classes,
  ...sources,
  fileURLToPath(new URL("../native/java/PairingWorker.java", import.meta.url)),
]);
execFileSync("jar", [
  "--create",
  "--file",
  fileURLToPath(new URL("jam-pairing.jar", directory)),
  "-C",
  classes,
  ".",
]);
console.log(
  "Built pairing helper from Android CodeExchange with Bouncy Castle 1.83",
);
