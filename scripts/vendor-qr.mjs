import { build } from "esbuild";
import { copyFile } from "node:fs/promises";

await build({
  entryPoints: ["scripts/qr-entry.js"],
  outfile: "extension/vendor/qr.js",
  bundle: true,
  format: "iife",
  globalName: "JamQr",
  minify: true,
});
await copyFile(
  "node_modules/qrcode/license",
  "extension/vendor/QRCODE-LICENSE",
);
await copyFile("node_modules/jsqr/LICENSE", "extension/vendor/JSQR-LICENSE");
