"use strict";

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const sourcePath = process.argv[2];
if (!sourcePath || !fs.existsSync(sourcePath)) {
  throw new Error("生成元アイコンのファイルパスを指定してください。");
}

const iconDirectory = path.resolve(__dirname, "..", "icons");
fs.mkdirSync(iconDirectory, { recursive: true });
const sourceOutput = path.join(iconDirectory, "app-icon-source.png");
fs.copyFileSync(sourcePath, sourceOutput);

const outputs = [
  ["favicon-32.png", 32],
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512]
];

async function main() {
  for (const [fileName, size] of outputs) {
    await sharp(sourcePath)
      .resize(size, size, { fit: "cover", position: "centre" })
      .png({ compressionLevel: 9 })
      .toFile(path.join(iconDirectory, fileName));
  }
  console.log([sourceOutput, ...outputs.map(([fileName]) => path.join(iconDirectory, fileName))].join("\n"));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
