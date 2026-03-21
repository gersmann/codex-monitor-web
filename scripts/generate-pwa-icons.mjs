import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const sourcePath = resolve(repoRoot, "public/app-icon.png");

const targets = [
  { fileName: "app-icon-180.png", size: 180 },
  { fileName: "app-icon-192.png", size: 192 },
  { fileName: "app-icon-512.png", size: 512 },
];

function resizeNearestNeighbor(source, targetSize) {
  const output = new PNG({ width: targetSize, height: targetSize });
  for (let y = 0; y < targetSize; y += 1) {
    const sourceY = Math.min(
      source.height - 1,
      Math.floor(((y + 0.5) * source.height) / targetSize),
    );
    for (let x = 0; x < targetSize; x += 1) {
      const sourceX = Math.min(
        source.width - 1,
        Math.floor(((x + 0.5) * source.width) / targetSize),
      );
      const sourceIndex = (sourceY * source.width + sourceX) * 4;
      const targetIndex = (y * targetSize + x) * 4;
      output.data[targetIndex] = source.data[sourceIndex];
      output.data[targetIndex + 1] = source.data[sourceIndex + 1];
      output.data[targetIndex + 2] = source.data[sourceIndex + 2];
      output.data[targetIndex + 3] = source.data[sourceIndex + 3];
    }
  }
  return output;
}

function main() {
  const source = PNG.sync.read(readFileSync(sourcePath));
  mkdirSync(resolve(repoRoot, "public"), { recursive: true });
  for (const target of targets) {
    const output = resizeNearestNeighbor(source, target.size);
    writeFileSync(
      resolve(repoRoot, `public/${target.fileName}`),
      PNG.sync.write(output),
    );
  }
}

main();
