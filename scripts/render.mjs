// G4 動画レンダリング（子プロセスで実行）。
// 使い方: node scripts/render.mjs <inputPropsJsonPath> <outMp4Path>
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia, ensureBrowser } from "@remotion/renderer";
import fs from "node:fs";
import path from "node:path";

const propsPath = process.argv[2];
const outPath = process.argv[3];
if (!propsPath || !outPath) {
  console.error("usage: render.mjs <propsPath> <outPath>");
  process.exit(2);
}

const inputProps = JSON.parse(fs.readFileSync(propsPath, "utf8"));

await ensureBrowser();
const serveUrl = await bundle({
  entryPoint: path.join(process.cwd(), "remotion/index.ts"),
});
const composition = await selectComposition({
  serveUrl,
  id: "MotionComic",
  inputProps,
});
await renderMedia({
  composition,
  serveUrl,
  codec: "h264",
  outputLocation: outPath,
  inputProps,
});
console.log("RENDER_OK");
