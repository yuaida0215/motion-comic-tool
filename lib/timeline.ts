/**
 * G4タイムライン計算。
 * 各コマの開始時刻、コマ内の「吹き出し文字の順次出現」タイミング（セリフ実尺に同期）、
 * 音声クリップの配置、総尺を算出する。reveal_timing はコマ内ローカル秒。
 */
import type { Project } from "./schema";

export const FPS = 30;
const GAP = 0.35; // セリフ間の小休止(秒)
const REVEAL_KINDS = new Set(["speech", "thought", "narration"]);

export type Reveal = {
  bubbleIndex: number;
  startSec: number; // コマ内ローカル：文字が出る時刻
  endSec: number; // コマ内ローカル：文字が消える/コマ終わりまで
  clip: string | null; // 音声クリップ(相対パス)
  voiceDur: number;
  revealImg: string | null; // 原画から切り出した文字部分(相対パス)。G4で埋める
  revealBox: [number, number, number, number] | null; // 切り出した領域(ページ座標)。G4で埋める
};
export type SfxPlay = { clip: string; startSec: number; dur: number };
export type ShotTiming = {
  id: string;
  startSec: number; // 動画全体での開始
  durSec: number;
  reveals: Reveal[];
  sfx: SfxPlay[];
};
/** 文字カード（タイトル/アイキャッチ/ナレ）のタイムライン配置（デバイスD/E）。 */
export type CardTiming = {
  id: string;
  role: string;
  template: string;
  lines: string[];
  startSec: number;
  durSec: number;
};
export type Timeline = {
  fps: number;
  totalSec: number;
  shots: ShotTiming[];
  cards: CardTiming[];
};

function shotTiming(s: Project["shots"][number], startSec: number): ShotTiming {
  const dur = s.duration_sec && s.duration_sec > 0 ? s.duration_sec : 3;
  const reveals: Reveal[] = [];
  let off = 0;
  s.bubbles.forEach((b, idx) => {
    if (!REVEAL_KINDS.has(b.kind) || !(b.text ?? "").trim()) return;
    const v = s.voice.find((x) => x.bubble_index === idx);
    const voiceDur = v?.dur ?? Math.max(1.2, (b.text?.length ?? 4) * 0.12);
    reveals.push({
      bubbleIndex: idx,
      startSec: Math.min(off, Math.max(0, dur - 0.4)),
      endSec: dur,
      clip: v?.clip ?? null,
      voiceDur,
      revealImg: null,
      revealBox: null,
    });
    off += voiceDur + GAP;
  });
  // 効果音はコマ頭あたりに（複数なら少しずらして）配置
  const sfx: SfxPlay[] = s.sfx.map((sx, i) => ({
    clip: sx.clip,
    startSec: Math.min(0.15 + i * 0.3, Math.max(0, dur - 0.3)),
    dur: sx.dur,
  }));
  return { id: s.id, startSec, durSec: dur, reveals, sfx };
}

export function computeTimeline(project: Project): Timeline {
  // カードを「先頭(at_start)」「指定コマの後(after_shot)」に振り分ける。
  const cardsList = project.cards ?? [];
  const atStart = cardsList.filter((c) => c.at_start);
  const afterMap = new Map<string, typeof cardsList>();
  for (const c of cardsList) {
    if (!c.at_start && c.after_shot) {
      const a = afterMap.get(c.after_shot) ?? [];
      a.push(c);
      afterMap.set(c.after_shot, a);
    }
  }
  const placed = new Set<string>();

  let cursor = 0;
  const cards: CardTiming[] = [];
  const placeCard = (c: (typeof cardsList)[number]) => {
    const durSec = c.dur_sec && c.dur_sec > 0 ? c.dur_sec : 2.5;
    cards.push({ id: c.id, role: c.role, template: c.template, lines: c.lines, startSec: cursor, durSec });
    cursor += durSec;
    placed.add(c.id);
  };

  for (const c of atStart) placeCard(c);

  // コマは project.shots の順で積む（timeline.shots[i] と project.shots[i] の対応は不変）。
  const shots: ShotTiming[] = [];
  for (const s of project.shots) {
    const st = shotTiming(s, cursor);
    shots.push(st);
    cursor += st.durSec;
    for (const c of afterMap.get(s.id) ?? []) placeCard(c);
  }
  // 配置されなかったカード（after_shot が存在しないコマを指す等）は末尾に出す（取りこぼし防止）。
  for (const c of cardsList) if (!placed.has(c.id)) placeCard(c);

  return { fps: FPS, totalSec: Math.max(1, cursor), shots, cards };
}
