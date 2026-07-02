/**
 * 音声の後処理（速さ・ピッチ）。server専用（ffmpeg を child_process で実行）。
 * ElevenLabs(v3) は speed/pitch を持たないので、生成後にここで効かせる。
 * pitch は asetrate（声の太さ=フォルマントごと移動）で変える＝低く/高く自然に寄る。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// ffmpeg-static の binary。webpackで__dirnameが壊れるので cwd から直接解決する。
function ffmpegBin(): string | null {
  const cwdPath = path.join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg");
  if (existsSync(cwdPath)) return cwdPath;
  return null;
}

/** atempo は 0.5〜2.0 のみ受けるので、範囲外は掛け合わせに分解する。 */
function atempoChain(total: number): string[] {
  let t = total;
  const parts: number[] = [];
  while (t > 2) {
    parts.push(2);
    t /= 2;
  }
  while (t < 0.5) {
    parts.push(0.5);
    t /= 0.5;
  }
  parts.push(t);
  return parts.map((p) => `atempo=${p.toFixed(4)}`);
}

export function applySpeedPitch(input: Buffer, speed = 1, pitchSemitones = 0): Buffer {
  const s = speed || 1;
  const p = pitchSemitones || 0;
  if (s === 1 && p === 0) return input;
  const ffmpeg = ffmpegBin();
  if (!ffmpeg) return input;

  const ratio = Math.pow(2, p / 12); // ピッチ比（>1で高く）
  const totalTempo = (1 / ratio) * s; // asetrateで変わったテンポを戻し、さらに速さを掛ける
  const filters = ["aresample=44100"];
  if (p !== 0) filters.push(`asetrate=${Math.round(44100 * ratio)}`);
  filters.push(...atempoChain(totalTempo));
  filters.push("aresample=44100");

  try {
    return execFileSync(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-af", filters.join(","), "-f", "mp3", "pipe:1"],
      { input, maxBuffer: 64 * 1024 * 1024 }
    );
  } catch {
    return input; // 失敗時は素のまま
  }
}

/**
 * 音声(mp3)を解析し「声が出ている区間」[start,end]（秒）を返す。offsetSec を各区間に加算。
 * 口パクを“喋っている間だけ”にするための包絡線。ffmpegでPCM(16k mono)に展開しRMSで判定。
 */
export function voicedIntervals(input: Buffer, offsetSec = 0): [number, number][] {
  const ffmpeg = ffmpegBin();
  if (!ffmpeg) return [];
  let pcm: Buffer;
  try {
    pcm = execFileSync(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"],
      { input, maxBuffer: 256 * 1024 * 1024 }
    );
  } catch {
    return [];
  }
  const SR = 16000;
  const win = Math.round(SR * 0.03); // 30ms窓（音節を追えるよう細かめ）
  const samples = Math.floor(pcm.length / 2);
  const rms: number[] = [];
  for (let i = 0; i < samples; i += win) {
    let sum = 0;
    let n = 0;
    for (let j = i; j < Math.min(i + win, samples); j++) {
      const v = pcm.readInt16LE(j * 2) / 32768;
      sum += v * v;
      n++;
    }
    rms.push(n ? Math.sqrt(sum / n) : 0);
  }
  const peak = Math.max(0.0001, ...rms);
  const thr = Math.max(0.02, peak * 0.15);
  const winSec = win / SR;
  const intervals: [number, number][] = [];
  let start = -1;
  for (let k = 0; k < rms.length; k++) {
    const on = rms[k] >= thr;
    if (on && start < 0) start = k;
    if (!on && start >= 0) {
      intervals.push([start * winSec, k * winSec]);
      start = -1;
    }
  }
  if (start >= 0) intervals.push([start * winSec, rms.length * winSec]);
  // 近い区間を結合（60ms未満の隙間のみ＝音節間の谷は残す）＋短すぎ(50ms未満)を除去
  const merged: [number, number][] = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] - last[1] < 0.06) last[1] = iv[1];
    else merged.push([iv[0], iv[1]]);
  }
  return merged
    .filter((iv) => iv[1] - iv[0] >= 0.05)
    .map((iv) => [Math.round((iv[0] + offsetSec) * 100) / 100, Math.round((iv[1] + offsetSec) * 100) / 100]);
}

/**
 * コマ内の全セリフ音声から「口の開きレベル列」を作る（3段階：0=閉/1=半開き/2=開き）。
 * 音量エンベロープ(RMS)で駆動：無音の谷は閉じ、喋っている間は半開きを基準に、大きい音の山で開く。
 * これで「ずっと開きっぱなし」でも「カクカク2値」でもない、音の大小に追従した自然な口パクになる。
 *
 *  clips   … そのコマで鳴る各クリップ {音声buf, コマ内開始秒offsetSec}
 *  durSec  … コマ尺（レベル列はこの長さぶん作る）
 *  step    … レベル列の時間解像度（秒）。composition 側は floor(tSec/step) で引く。
 * 返り値 … length=ceil(durSec/step) の 0/1/2 配列（コマ先頭からの時間順）。
 */
export function mouthLevels(
  clips: { buf: Buffer; offsetSec: number }[],
  durSec: number,
  step = 0.06
): number[] {
  const nBins = Math.max(1, Math.ceil(durSec / step));
  const ffmpeg = ffmpegBin();
  if (!ffmpeg || clips.length === 0) return new Array(nBins).fill(0);

  const SR = 16000;
  const win = Math.round(SR * 0.03); // 30ms窓（音節を追える細かさ）
  // 各クリップを「自分のピーク」で正規化して bin に入れる。コマ内に音量差のある複数クリップ
  // （別話者・別TTSエンジン・別感情で出力レベルが違う）があっても、静かな台詞の口が
  // 半開き/閉じに張り付かず、その台詞自身の大きい音節で開く。bin には正規化値(0..1)の最大を採る。
  const binVal = new Array(nBins).fill(0);
  let any = false;
  for (const { buf, offsetSec } of clips) {
    let pcm: Buffer;
    try {
      pcm = execFileSync(
        ffmpeg,
        ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"],
        { input: buf, maxBuffer: 256 * 1024 * 1024 }
      );
    } catch {
      continue;
    }
    const total = Math.floor(pcm.length / 2);
    const winRms: { t: number; rms: number }[] = [];
    for (let i = 0; i < total; i += win) {
      let sum = 0;
      let n = 0;
      for (let j = i; j < Math.min(i + win, total); j++) {
        const v = pcm.readInt16LE(j * 2) / 32768;
        sum += v * v;
        n++;
      }
      winRms.push({ t: offsetSec + i / SR, rms: n ? Math.sqrt(sum / n) : 0 });
    }
    let clipPeak = 0;
    for (const w of winRms) if (w.rms > clipPeak) clipPeak = w.rms;
    if (clipPeak < 0.02) continue; // ほぼ無音のクリップ＝その時間帯は閉じのまま（寄与させない）
    any = true;
    for (const w of winRms) {
      const b = Math.floor(w.t / step);
      if (b >= 0 && b < nBins) binVal[b] = Math.max(binVal[b], w.rms / clipPeak);
    }
  }
  if (!any) return new Array(nBins).fill(0);

  const FLOOR = 0.12; // 各クリップ自身のピーク比。これ未満＝無音（口を閉じる）
  const OPEN = 0.5; // これ以上＝大きい音（口を開く）
  // 発声の有無（FLOOR超え）。音節間の短い谷(<0.2s)は前後が発声なら橋渡し＝喋りの途中で口を閉じ切らない
  const on = binVal.map((v) => v >= FLOOR);
  const bridge = Math.max(1, Math.round(0.2 / step));
  for (let i = 0; i < nBins; i++) {
    if (on[i]) continue;
    let prev = false;
    let next = false;
    for (let k = 1; k <= bridge && !prev; k++) if (i - k >= 0 && binVal[i - k] >= FLOOR) prev = true;
    for (let k = 1; k <= bridge && !next; k++) if (i + k < nBins && binVal[i + k] >= FLOOR) next = true;
    if (prev && next) on[i] = true;
  }
  // レベル化：発声外=閉(0)、発声中=半開き(1)を基準に大きい音は開き(2)
  const levels = new Array<number>(nBins).fill(0);
  for (let i = 0; i < nBins; i++) {
    if (!on[i]) continue;
    levels[i] = binVal[i] >= OPEN ? 2 : 1;
  }
  // 1bin だけの孤立した変化を均す（チラつき防止）
  for (let i = 1; i < nBins - 1; i++) {
    if (levels[i] !== levels[i - 1] && levels[i - 1] === levels[i + 1]) levels[i] = levels[i - 1];
  }
  return levels;
}
