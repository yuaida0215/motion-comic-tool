/**
 * 最小BGM一発（プレースホルダ）。指定秒数のやわらかいパッド音をWAVで合成する。
 * §12-3の暫定：1曲固定の代わりに、尺ぴったりの簡易アンビエントを生成（後で実BGMに差し替え）。
 * 生成系/著作権の心配がなく、無料・決定的。Remotionで低音量で敷く。
 */
export function makeBgmWav(seconds: number): Buffer {
  const sr = 44100;
  const n = Math.max(1, Math.floor(seconds * sr));
  const data = Buffer.alloc(n * 2);
  const freqs = [110, 164.81, 220, 277.18]; // ゆるい和音（A基調）
  const fade = Math.floor(sr * 1.0);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    for (const f of freqs) s += Math.sin(2 * Math.PI * f * t);
    s /= freqs.length;
    const trem = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.13 * t); // ゆっくりトレモロ
    let env = 0.5 * trem;
    if (i < fade) env *= i / fade;
    if (i > n - fade) env *= (n - i) / fade;
    const v = Math.max(-1, Math.min(1, s * env));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
