/**
 * マンガの読み順（右上→左、上の段→下の段）で要素を並べ替える汎用ヘルパー。
 * G0の自動検出、および人が手動でコマを追加/移動した後の並び替えの両方から使う。
 * 「段」= y範囲が大きく重なる要素同士（Union-Findでクラスタ化）。段間は最小yの昇順、
 * 段内は中心x座標の降順（右が先）。同じx帯なら上の要素を先に。
 */
import type { BBox } from "./schema";

export function orderByReadingOrder<T>(items: T[], getBox: (item: T) => BBox): T[] {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < n; i++) {
    const [, yi, , hi] = getBox(items[i]);
    for (let j = i + 1; j < n; j++) {
      const [, yj, , hj] = getBox(items[j]);
      const overlap = Math.min(yi + hi, yj + hj) - Math.max(yi, yj);
      const minH = Math.min(hi, hj);
      if (minH > 0 && overlap / minH > 0.3) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  const rows = [...groups.values()].map((idxs) => ({
    idxs,
    minY: Math.min(...idxs.map((i) => getBox(items[i])[1])),
  }));
  rows.sort((a, b) => a.minY - b.minY);
  const order: number[] = [];
  for (const row of rows) {
    row.idxs.sort((a, b) => {
      const boxA = getBox(items[a]);
      const boxB = getBox(items[b]);
      const cxA = boxA[0] + boxA[2] / 2;
      const cxB = boxB[0] + boxB[2] / 2;
      if (Math.abs(cxA - cxB) > 1) return cxB - cxA; // 右が先
      return boxA[1] - boxB[1]; // 同じx帯なら上が先
    });
    order.push(...row.idxs);
  }
  return order.map((i) => items[i]);
}
