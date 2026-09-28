import { copyFile, mkdir } from "node:fs/promises";

const destination = new URL("../extension/vendor/", import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(
  new URL("../node_modules/lucide/dist/umd/lucide.min.js", import.meta.url),
  new URL("lucide.min.js", destination),
);
await copyFile(
  new URL("../node_modules/lucide/LICENSE", import.meta.url),
  new URL("LUCIDE-LICENSE", destination),
);
