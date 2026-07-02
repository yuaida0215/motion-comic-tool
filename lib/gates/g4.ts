/**
 * G4 モーション・DEMO（Remotionでmp4書き出し）
 * ------------------------------------------------------------------
 * タイムライン計算 → reveal_timing書き戻し → 最小BGM生成 → Remotionレンダリング
 * → mp4をストレージへ保存。
 *
 * 動き（口は動かさない方針）: パネル画像にカメラ移動(zoom/pan/shake/static)、
 * 文字は吹き出しの順次出現（セリフ実尺に同期）、音声＋最小BGMを敷く。
 * レンダリングは環境で自動切替:
 *  - 本番(Vercel等サーバレス): AWS Remotion Lambda（Chromiumをサーバレス上で直接
 *    起動できないため）。REMOTION_LAMBDA_* 環境変数が揃っていればこちら。
 *  - ローカル開発: 従来どおり proven な standalone スクリプト(scripts/render.mjs)を
 *    子プロセスで実行（Chromiumをローカルで直接起動）。
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { makeBgmWav } from "../bgm";
import { voicedIntervals, mouthLevels } from "../audiofx";
import { loadPageImage, type LoadedImage } from "../image";
import { lambdaConfigured, renderOnLambda } from "../lambdaRender";
import { computeTimeline } from "../timeline";
import { getStorage } from "../storage";
import type { Project } from "../schema";

export async function gateG4(
  project: Project,
  baseUrl: string
): Promise<{ api_cost: number; note: string }> {
  if (!project.pipeline.G1.approved) {
    throw new Error("先にG1（コンテ）を承認してください");
  }
  if (!project.shots.some((s) => s.layers.background_inpainted)) {
    throw new Error("先にG2（文字消し・素材分解）を実行してください");
  }

  const tl = computeTimeline(project);
  const storage = getStorage();
  // 多ページ：コマごとに「そのページ」の画像から文字を切り出す（ページ画像はキャッシュ）。
  const pageCache = new Map<string, LoadedImage>();
  const getPage = async (pid: string) => {
    if (!pageCache.has(pid)) pageCache.set(pid, await loadPageImage(project, pid));
    return pageCache.get(pid)!;
  };

  // reveal_timing を書き戻し＋「原画の文字部分」を切り出して保存（文字の順次出現用）
  for (let i = 0; i < tl.shots.length; i++) {
    const st = tl.shots[i];
    const shot = project.shots[i];
    if (!shot) continue;
    const img = st.reveals.length > 0 ? await getPage(shot.page_id) : null;
    for (const r of st.reveals) {
      const b = shot.bubbles[r.bubbleIndex];
      if (!b) continue;
      b.reveal_timing = { start: r.startSec, end: r.endSec };
      if (!b.bbox || !img) continue;
      // 原画から文字領域を切り出し（移動のみ＝フィデリティ保持）。
      // 復元範囲は「G2が実際に消した範囲(erase_box)」を最優先で使う＝消した分を過不足なく戻す
      // （多列セリフが消えたまま=セリフ切れ、を防ぐ）。erase_box が無い古いデータは bbox+余白で代替。
      const [shX, shY, shW, shH] = shot.bbox;
      let rx: number, ry: number, rw0: number, rh0: number;
      if (b.erase_box) {
        [rx, ry, rw0, rh0] = b.erase_box;
      } else {
        const [bx, by, bw, bh] = b.bbox;
        const padX = Math.round(bw * 0.1) + 4;
        const padY = Math.round(bh * 0.06) + 4;
        rx = bx - padX;
        ry = by - padY;
        rw0 = bw + padX * 2;
        rh0 = bh + padY * 2;
      }
      // コマbbox内に収める（枠線・隣コマへの干渉防止）。
      const left = Math.max(shX, Math.min(Math.round(rx), shX + shW - 1));
      const top = Math.max(shY, Math.min(Math.round(ry), shY + shH - 1));
      const width = Math.max(1, Math.min(Math.round(rw0), shX + shW - left));
      const height = Math.max(1, Math.min(Math.round(rh0), shY + shH - top));
      const crop = await sharp(img.bytes)
        .extract({ left, top, width, height })
        .png()
        .toBuffer();
      const rel = `reveal/${shot.id}_b${r.bubbleIndex}.png`;
      await storage.putAsset(project.meta.project_id, rel, crop, "image/png");
      r.revealImg = rel;
      r.revealBox = [left, top, width, height];
    }

    // 口パク：声を解析（口が見えるコマのみ）。voiced=発声区間（体の微動/後方互換）、
    // levels=音量エンベロープ由来の口の開き列（0=閉/1=半/2=開）でコマ内を駆動する。
    if (shot.mouth?.open_img) {
      const voiced: [number, number][] = [];
      const clips: { buf: Buffer; offsetSec: number }[] = [];
      for (const r of st.reveals) {
        if (!r.clip) continue;
        const cb = await storage.getAssetBytes(project.meta.project_id, r.clip);
        if (!cb) continue;
        voiced.push(...voicedIntervals(cb, r.startSec));
        clips.push({ buf: cb, offsetSec: r.startSec });
      }
      shot.mouth.voiced = voiced;
      const step = shot.mouth.level_step || 0.06;
      shot.mouth.levels = mouthLevels(clips, st.durSec, step);
      shot.mouth.level_step = step;
    }
  }

  // 最小BGM（尺ぴったり生成）
  const bgmRel = "bgm/bgm.wav";
  await storage.putAsset(project.meta.project_id, bgmRel, makeBgmWav(tl.totalSec), "audio/wav");
  project.meta.bgm_track = bgmRel;

  const assetBase = `${baseUrl}/api/assets/${project.meta.project_id}`;
  const inputProps = { project, assetBase, timeline: tl };

  // 本番(AWS Remotion Lambda設定あり): Lambdaでレンダー。
  // ローカル開発(未設定): 従来どおり子プロセスでChromiumを直接起動。
  // ※baseUrlがlocalhostの時は、Lambda設定があっても必ずローカルレンダーにする。
  //   AWS上のLambdaは localhost:3100 の画像/音声に到達できず、確実に
  //   「Error loading image with src: http://localhost:...」で失敗するため
  //   （.env.localに本番用のLambda設定を入れたままローカル開発する場合の事故防止）。
  const isLocalBase = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(baseUrl);
  const useLambda = lambdaConfigured() && !isLocalBase;
  const mp4 = useLambda
    ? await renderOnLambda(inputProps)
    : await renderViaLocalChild(inputProps);

  const mp4Rel = "demo.mp4";
  await storage.putAsset(project.meta.project_id, mp4Rel, mp4, "video/mp4");
  project.outputs.demo_mp4 = mp4Rel;

  return {
    api_cost: 0,
    note: `mp4 ${tl.totalSec.toFixed(1)}s / ${tl.shots.length}コマ / ${(mp4.length / 1024 / 1024).toFixed(1)}MB / render=${useLambda ? "lambda" : "local"}`,
  };
}

async function renderViaLocalChild(inputProps: Record<string, unknown>): Promise<Buffer> {
  const projectId = (inputProps.project as Project).meta.project_id;
  const tmp = os.tmpdir();
  const propsPath = path.join(tmp, `${projectId}_props.json`);
  const outPath = path.join(tmp, `${projectId}_demo.mp4`);
  await fs.writeFile(propsPath, JSON.stringify(inputProps), "utf8");
  try {
    await renderViaChild(propsPath, outPath);
    return await fs.readFile(outPath);
  } finally {
    await fs.rm(propsPath, { force: true });
    await fs.rm(outPath, { force: true });
  }
}

function renderViaChild(propsPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = path.join(process.cwd(), "scripts", "render.mjs");
    const child = spawn(process.execPath, [script, propsPath, outPath], {
      cwd: process.cwd(),
    });
    let err = "";
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`レンダリング失敗(code ${code}): ${err.slice(-600)}`));
    });
  });
}
