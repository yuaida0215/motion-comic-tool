/**
 * 吹き出し内テキストの精密消去（CV・生成なし）
 * ------------------------------------------------------------------
 * 精度の高い吹き出し枠(G0の2パス検出)を前提に、各枠で:
 *   1) 枠付近ROIで白い内部領域を flood fill（文字の黒は壁になり内部白だけ連結）。
 *   2) ROIの縁から「内部以外」を flood → 外側(枠線・外の絵)。
 *   3) 内部でも外側でもない＝白に囲まれた穴＝文字。内部＋穴を白で塗る。
 * → 吹き出しの輪郭線も外の絵も触らず、内部の文字だけが消える。フィデリティ完全。
 */
import sharp from "sharp";

export type LocalBox = { x: number; y: number; w: number; h: number };

const WHITE_T = 186;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** 指定ボックス内（枠線を避けて少し内側）の暗い画素の割合。白塗り後に文字が残っているか判定用。 */
export async function darkRatioInBox(pngBuf: Buffer, box: LocalBox): Promise<number> {
  const { data, info } = await sharp(pngBuf)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const C = info.channels;
  const inset = 3;
  const x0 = Math.max(0, box.x + inset);
  const y0 = Math.max(0, box.y + inset);
  const x1 = Math.min(info.width, box.x + box.w - inset);
  const y1 = Math.min(info.height, box.y + box.h - inset);
  if (x1 <= x0 || y1 <= y0) return 0;
  let dark = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * W + x) * C;
      const g = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
      if (g < 150) dark++;
      total++;
    }
  }
  return total ? dark / total : 0;
}

/**
 * 検出した文字枠を「それを囲む白い吹き出しの内側」いっぱいにスナップして返す（CV・生成なし）。
 * LLMの枠は文字にタイト過ぎ／一列しか囲わないことがあるが、白吹き出し内部はひと続きの白領域なので、
 * 枠内の白からflood fillして白ブロブの外接矩形を取れば、吹き出し全体（複数列の文字も含む）を覆える。
 * 安全策: 白がROI縁に達した（＝枠の無い背景に漏れた／端で開いた吹き出し）場合は広げず元の枠を返す。
 */
export async function snapBubbleToWhite(shotPng: Buffer, box: LocalBox): Promise<LocalBox> {
  const { data, info } = await sharp(shotPng).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const C = info.channels;
  // ROI：吹き出し全体が入るよう枠を大きめに広げる（複数列の取りこぼし対策）。
  const ex = Math.round(box.w * 1.2) + 16;
  const ey = Math.round(box.h * 1.2) + 16;
  const x0 = clamp(box.x - ex, 0, W);
  const y0 = clamp(box.y - ey, 0, H);
  const x1 = clamp(box.x + box.w + ex, 0, W);
  const y1 = clamp(box.y + box.h + ey, 0, H);
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw <= 2 || rh <= 2) return box;
  const gray = (x: number, y: number) => {
    const o = (y * W + x) * C;
    return data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
  };
  const li = (x: number, y: number) => (y - y0) * rw + (x - x0);
  const seen = new Uint8Array(rw * rh);
  const stack: number[] = [];
  // 種：元の文字枠の内側にある白画素（吹き出し内部の点）
  const bx0 = clamp(box.x, x0, x1);
  const by0 = clamp(box.y, y0, y1);
  const bx1 = clamp(box.x + box.w, x0, x1);
  const by1 = clamp(box.y + box.h, y0, y1);
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      if (gray(x, y) >= WHITE_T && !seen[li(x, y)]) {
        seen[li(x, y)] = 1;
        stack.push(y * W + x);
      }
    }
  }
  if (stack.length === 0) return box; // 枠内に白が無い＝吹き出しでない/暗い → 広げない
  let minx = x1,
    miny = y1,
    maxx = x0,
    maxy = y0;
  while (stack.length) {
    const gi = stack.pop()!;
    const x = gi % W;
    const y = (gi / W) | 0;
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
    const nb = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];
    for (const [nx, ny] of nb) {
      if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
      if (!seen[li(nx, ny)] && gray(nx, ny) >= WHITE_T) {
        seen[li(nx, ny)] = 1;
        stack.push(ny * W + nx);
      }
    }
  }
  // 漏れ判定：白ブロブがROIの縁に達した＝囲いが開いている/背景に漏れた → 元の枠を維持（安全側）。
  const leaked = minx <= x0 + 1 || miny <= y0 + 1 || maxx >= x1 - 2 || maxy >= y1 - 2;
  if (leaked) return box;
  // 取り過ぎガード：白が隣の吹き出しや背景に広がった場合（元枠の2.4倍超、または画像の28%超）は採用せず元の枠を維持。
  // これが無いと、白背景のコマで枠がコマ全体に膨張して他要素を侵食する。
  const blobArea = (maxx - minx + 1) * (maxy - miny + 1);
  const origArea = Math.max(1, box.w * box.h);
  if (blobArea > origArea * 2.4 || blobArea > W * H * 0.28) return box;
  // 元の文字枠と和集合（縮めない）して返す。
  const nx0 = Math.min(minx, box.x);
  const ny0 = Math.min(miny, box.y);
  const nx1 = Math.max(maxx + 1, box.x + box.w);
  const ny1 = Math.max(maxy + 1, box.y + box.h);
  return { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 };
}

export async function eraseTextInBubbles(
  shotPng: Buffer,
  bubbles: LocalBox[]
): Promise<{ buf: Buffer; boxes: LocalBox[] }> {
  const { data, info } = await sharp(shotPng)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const C = info.channels;

  const gray = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * C;
    gray[i] = (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114) | 0;
  }

  // 各吹き出しで「実際に白塗りした範囲」を返す＝G4のreveal(復元)を消した範囲とぴったり一致させ、
  // 多列セリフが「消えたまま復元されない（＝セリフ切れ）」を防ぐ。
  // ※白塗りは必ず flood（白に囲まれた内部＋穴=文字）だけ。四角く塗ると絵に白い穴が開く＝厳禁。
  const boxes: LocalBox[] = [];

  // 「白」のしきい値を吹き出しごとに適応的に決める。
  // 固定の WHITE_T(186) だけだと、明るいグレーの空/トーン(実測190〜226)まで「白」と誤判定され、
  // 吹き出しの白とひと続きになって背景へ漏れ、空が探索範囲まるごと白塗りされる事故が起きた（実データで確認）。
  // 吹き出し内部は紙の白(実測250前後)で背景グレーよりはっきり明るいので、文字枠内の白画素の中央値から
  // 相対で下げた値をしきい値にする（背景も真っ白に近いページでは従来どおり WHITE_T が下限）。
  const whiteThreshold = (bx0: number, by0: number, bx1: number, by1: number): number => {
    const samples: number[] = [];
    for (let y = by0; y < by1; y++) {
      for (let x = bx0; x < bx1; x++) {
        const g = gray[y * W + x];
        if (g >= WHITE_T) samples.push(g);
      }
    }
    if (samples.length < 50) return WHITE_T; // 白が少なすぎて実測できない→従来どおり
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    return Math.max(WHITE_T, Math.min(median - 22, 240));
  };

  for (const b of bubbles) {
    // 探索ROIを広めに取る＝枠は文字ぎりぎり(タイト)のままでも、白い吹き出し内部をfloodして
    // 隣の列（多列セリフ）まで消せる。横（列方向）を特に広げる。
    // ※塗るのは「白に囲まれた内部＋穴(文字)」だけなので、別の吹き出しや背景の絵は塗られない（縁から外側floodで保護）。
    const ex = Math.round(b.w * 0.8) + 12;
    const ey = Math.round(b.h * 0.35) + 10;
    const x0 = clamp(b.x - ex, 0, W);
    const y0 = clamp(b.y - ey, 0, H);
    const x1 = clamp(b.x + b.w + ex, 0, W);
    const y1 = clamp(b.y + b.h + ey, 0, H);
    const rw = x1 - x0;
    const rh = y1 - y0;
    if (rw <= 1 || rh <= 1) continue;

    const li = (x: number, y: number) => (y - y0) * rw + (x - x0);
    const interior = new Uint8Array(rw * rh);
    const outside = new Uint8Array(rw * rh);

    // 種: 元枠内の白画素（吹き出し内部に入っている点）
    const stack: number[] = [];
    const sbx0 = clamp(b.x, x0, x1);
    const sby0 = clamp(b.y, y0, y1);
    const sbx1 = clamp(b.x + b.w, x0, x1);
    const sby1 = clamp(b.y + b.h, y0, y1);
    const T = whiteThreshold(sbx0, sby0, sbx1, sby1);
    const seedFrom = (ax0: number, ay0: number, ax1: number, ay1: number) => {
      for (let y = ay0; y < ay1; y++) {
        for (let x = ax0; x < ax1; x++) {
          if (gray[y * W + x] >= T && !interior[li(x, y)]) {
            interior[li(x, y)] = 1;
            stack.push(y * W + x);
          }
        }
      }
    };
    seedFrom(sbx0, sby0, sbx1, sby1);
    if (stack.length < rw * rh * 0.01) seedFrom(x0, y0, x1, y1); // 枠が白に当たってなければROI全体から

    // 内部白を flood（白のみ・4近傍・ROI内）
    while (stack.length) {
      const gi = stack.pop()!;
      const x = gi % W;
      const y = (gi / W) | 0;
      const nb = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];
      for (const [nx, ny] of nb) {
        if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
        if (!interior[li(nx, ny)] && gray[ny * W + nx] >= T) {
          interior[li(nx, ny)] = 1;
          stack.push(ny * W + nx);
        }
      }
    }

    // 外側: ROIの縁から「内部以外」を flood
    const st2: number[] = [];
    for (let x = x0; x < x1; x++) {
      for (const y of [y0, y1 - 1]) {
        const l = li(x, y);
        if (!interior[l] && !outside[l]) {
          outside[l] = 1;
          st2.push(y * W + x);
        }
      }
    }
    for (let y = y0; y < y1; y++) {
      for (const x of [x0, x1 - 1]) {
        const l = li(x, y);
        if (!interior[l] && !outside[l]) {
          outside[l] = 1;
          st2.push(y * W + x);
        }
      }
    }
    while (st2.length) {
      const gi = st2.pop()!;
      const x = gi % W;
      const y = (gi / W) | 0;
      const nb = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];
      for (const [nx, ny] of nb) {
        if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
        const l = li(nx, ny);
        if (!interior[l] && !outside[l]) {
          outside[l] = 1;
          st2.push(ny * W + nx);
        }
      }
    }

    // 内部でも外側でもない=白に囲まれた穴=文字 → そこだけ白で塗る（floodベース。絵は四角く切らない）。
    // 同時に「実際に塗った画素」の外接矩形を記録＝revealで復元すべき正範囲。
    let minx = x1,
      miny = y1,
      maxx = x0 - 1,
      maxy = y0 - 1,
      cnt = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!outside[li(x, y)]) {
          const o = (y * W + x) * C;
          data[o] = 255;
          data[o + 1] = 255;
          data[o + 2] = 255;
          if (x < minx) minx = x;
          if (x > maxx) maxx = x;
          if (y < miny) miny = y;
          if (y > maxy) maxy = y;
          cnt++;
        }
      }
    }
    // 復元範囲＝実際に消した外接矩形。元枠と和集合で取りこぼし無し（何も消さなければ元枠）。
    if (cnt > 0) {
      const rx0 = Math.min(minx, b.x);
      const ry0 = Math.min(miny, b.y);
      const rx1 = Math.max(maxx + 1, b.x + b.w);
      const ry1 = Math.max(maxy + 1, b.y + b.h);
      boxes.push({ x: rx0, y: ry0, w: rx1 - rx0, h: ry1 - ry0 });
    } else {
      boxes.push({ x: b.x, y: b.y, w: b.w, h: b.h });
    }
  }

  const buf = await sharp(data, { raw: { width: W, height: H, channels: C } })
    .png()
    .toBuffer();
  return { buf, boxes };
}
