import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const iconsDirectory = new URL("../apps/pwa/public/icons/", import.meta.url);
const source = await readFile(new URL("icon.svg", iconsDirectory));
await mkdir(iconsDirectory, { recursive: true });

await Promise.all([
  sharp(source).resize(192, 192).png().toFile(fileURLToPath(new URL("icon-192.png", iconsDirectory))),
  sharp(source).resize(512, 512).png().toFile(fileURLToPath(new URL("icon-512.png", iconsDirectory))),
  sharp(source).resize(180, 180).png().toFile(fileURLToPath(new URL("apple-touch-icon.png", iconsDirectory))),
  sharp(source).resize(96, 96).grayscale().png().toFile(fileURLToPath(new URL("badge-96.png", iconsDirectory))),
]);

process.stdout.write("CodexPulse PWA icons generated.\n");
