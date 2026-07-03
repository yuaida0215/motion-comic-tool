"use client";

import { useEffect, useRef, useState } from "react";
import {
  AGES,
  AGE_LABELS,
  BEATS,
  BUBBLE_KINDS,
  CAMERA_TYPES,
  EMOTIONS,
  GRADES,
  TONES,
  TONE_LABELS,
  VOICE_OPTIONS,
  safeParseProject,
  type Gate,
  type Project,
} from "@/lib/schema";
import { BACKGROUND_THEMES, CARD_TEMPLATES, PANEL_FRAME_PRESETS, TRANSITION_KITS, resolveFramePreset } from "@/lib/presets";

const FRAMING_LABELS: { value: string; label: string }[] = [
  { value: "auto", label: "自動" },
  { value: "fit", label: "全体(フィット)" },
  { value: "fill", label: "アップ(フィル)" },
  { value: "pan", label: "パンで全体" },
];

/** PanelStyle 数値 → 額装プリセットid（UIの<select>表示用に逆引き）。
 *  ps未設定(旧v1ドラフト復元)は "none"、プリセット非該当の手調整値は "custom"（保存時は送らず温存）。 */
function frameIdOf(ps?: Project["shots"][number]["panel_style"]): string {
  if (!ps) return "none";
  for (const [k, v] of Object.entries(PANEL_FRAME_PRESETS)) {
    const s = v.style;
    if (
      s.inset_pct === ps.inset_pct &&
      s.radius === ps.radius &&
      s.rotation_deg === ps.rotation_deg &&
      s.shadow === ps.shadow &&
      s.border_px === ps.border_px
    )
      return k;
  }
  return "custom";
}

/** 吹き出し種別の日本語ラベル。 */
const KIND_LABELS: Record<string, string> = {
  speech: "セリフ",
  thought: "心の声",
  narration: "ナレーション",
  scream: "叫び声",
  sfx: "効果音",
  other: "その他",
};
/** 声に出して読む種別（G3のTTS対象）。これらは話者・感情を選べる。
 *  scream(叫び声)はキャラ本人の発声＝配役した声で強い感情で読む。sfx(擬音)は専用の効果音生成。 */
const SPEAKABLE = new Set(["speech", "thought", "narration", "scream"]);

/** 感情の日本語ラベル。 */
const EMOTION_LABELS: Record<string, string> = {
  neutral: "普通",
  happy: "喜び",
  sad: "悲しみ",
  angry: "怒り・叫び",
  fearful: "恐怖・悲鳴",
  surprised: "驚き",
};

const GRADE_COLOR: Record<string, string> = {
  light: "#5fd08a",
  standard: "#e0b65a",
  advanced: "#ff7a7a",
};

export default function ReviewClient({
  initialProject,
  assetUrl,
}: {
  initialProject: Project;
  assetUrl: string;
}) {
  const [project, setProject] = useState<Project>(initialProject);
  // 多ページ：ページid("" =単一ページ)ごとの画像実寸。検出枠オーバーレイ＝ページ別。
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 「①自動で作成する」の今の工程（進捗表示用）。busy==="auto"の間だけ意味を持つ。
  const [autoStep, setAutoStep] = useState<string | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [editBoxes, setEditBoxes] = useState(false);
  const [editPanelBoxes, setEditPanelBoxes] = useState(false); // コマ枠(shot.bbox)自体のドラッグ編集
  const [showAdvanced, setShowAdvanced] = useState(false); // G0〜G4の個別操作は普段隠す（非エンジニア向け）
  // 左の画像のコマ枠 ⇔ 右のコマ編集カードの連動。どちらかをクリックすると両方が一瞬光る。
  const [highlightShotId, setHighlightShotId] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function focusShot(sid: string) {
    setHighlightShotId(sid);
    document.getElementById(`shot-card-${sid}`)?.scrollIntoView({ behavior: "auto", block: "center" });
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightShotId((cur) => (cur === sid ? null : cur)), 1600);
  }
  const dragRef = useRef<{
    target: "bubble" | "panel";
    kind: "move" | "resize";
    sid: string;
    bidx: number; // target==="panel"の時は使わない
    cx: number;
    cy: number;
    orig: [number, number, number, number];
    sx: number;
    sy: number;
    pw: number; // 操作中ページの実寸（クランプ用）
    ph: number;
  } | null>(null);

  const id = project.meta.project_id;
  const hasShots = project.shots.length > 0;
  const g1 = project.pipeline.G1;

  // 画像実寸をページ別に記録（onLoad＋キャッシュ済みの保険）。これが無いと検出枠が出ない。
  const noteSize = (pageId: string, el: HTMLImageElement | null) => {
    if (el && el.complete && el.naturalWidth > 0 && !sizes[pageId]) {
      setSizes((s) => ({ ...s, [pageId]: { w: el.naturalWidth, h: el.naturalHeight } }));
    }
  };

  // --- 編集の自動退避（ページ離脱・再読込・HMRで消えないように） ---
  // 編集内容を localStorage に下書き保存し、戻ってきたら復元する。
  const draftKey = `mc-draft-${id}`;
  const hydrated = useRef(false);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        // 旧バージョンで保存された下書きは新フィールド(cards/background/panel_style/mouth.disabled等)を欠く。
        // 必ず Zod を通して既定値を埋めてから復元する（生のcastだと undefined 参照でレビュー画面がクラッシュする）。
        const parsed = safeParseProject(JSON.parse(raw));
        const d = parsed.success ? parsed.data : null;
        if (d && JSON.stringify(d) !== JSON.stringify(initialProject)) {
          setProject(d);
          setRestored(true);
        }
      }
    } catch {
      /* ignore */
    }
    hydrated.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify(project));
    } catch {
      /* ignore */
    }
  }, [project, draftKey]);

  function discardDraft() {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
    setProject(initialProject);
    setRestored(false);
  }

  async function call(path: string, body?: unknown, label?: string) {
    setBusy(label || path);
    setErr(null);
    try {
      const res = await fetch(`/api/projects/${id}${path}`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      if (!res.ok || json.ok === false)
        throw new Error(json.error || "処理に失敗しました");
      if (json.project) {
        setProject(json.project);
        setRestored(false); // サーバに保存されたので「復元中」表示は消す
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function patchShot(sid: string, patch: Partial<Project["shots"][number]>) {
    setProject((p) => ({
      ...p,
      shots: p.shots.map((s) => (s.id === sid ? { ...s, ...patch } : s)),
    }));
  }
  function setDelivery(delivery: Project["meta"]["delivery"]) {
    setProject((p) => ({ ...p, meta: { ...p.meta, delivery } }));
    call("/review", { delivery }, "delivery");
  }
  function setTheme(theme: string) {
    setProject((p) => ({ ...p, meta: { ...p.meta, theme } }));
    call("/review", { theme }, "theme");
  }
  function patchBubble(
    sid: string,
    idx: number,
    patch: Partial<Project["shots"][number]["bubbles"][number]>
  ) {
    setProject((p) => ({
      ...p,
      shots: p.shots.map((s) =>
        s.id === sid
          ? {
              ...s,
              bubbles: s.bubbles.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
            }
          : s
      ),
    }));
  }
  // G0の検出漏れ（吹き出しが自動検出されなかった）を人が補える：コマ中央に小さな枠を追加し、
  // 「吹き出し枠を編集」で見えるようにする。位置・サイズは追加後にドラッグ/リサイズして合わせる。
  function addBubble(sid: string) {
    setProject((p) => ({
      ...p,
      shots: p.shots.map((s) => {
        if (s.id !== sid) return s;
        const [sx, sy, sw, sh] = s.bbox;
        const bw = Math.max(24, Math.round(sw * 0.22));
        const bh = Math.max(24, Math.round(sh * 0.16));
        const bx = Math.round(sx + (sw - bw) / 2);
        const by = Math.round(sy + (sh - bh) / 2);
        const newBubble: Project["shots"][number]["bubbles"][number] = {
          text: "",
          kind: "speech",
          bbox: [bx, by, bw, bh],
          speaker: null,
          emotion: "",
          sfx_prompt: "",
          erased_img: null,
          erase_box: null,
          reveal_timing: null,
        };
        return { ...s, bubbles: [...s.bubbles, newBubble] };
      }),
    }));
    setEditBoxes(true);
  }
  // 誤検出（絵の一部を吹き出しと誤認識した等）を削除する。
  function removeBubble(sid: string, idx: number) {
    setProject((p) => ({
      ...p,
      shots: p.shots.map((s) =>
        s.id === sid ? { ...s, bubbles: s.bubbles.filter((_, i) => i !== idx) } : s
      ),
    }));
  }

  // G0がコマ自体を検出しそこねた（コマ割りの誤り）時に、人がコマを追加できる。
  // ページ中央に控えめなサイズで置く→「コマ枠を編集」でドラッグ/リサイズして本来の位置に合わせる想定。
  async function addPanel(pageId: string) {
    const sz = sizes[pageId] ?? sizes[""];
    if (!sz) return;
    const bw = Math.max(80, Math.round(sz.w * 0.28));
    const bh = Math.max(80, Math.round(sz.h * 0.22));
    const bbox = [Math.round((sz.w - bw) / 2), Math.round((sz.h - bh) / 2), bw, bh];
    await call("/review", { add_shot: { page_id: pageId, bbox } }, "addpanel");
    setEditPanelBoxes(true);
    setEditBoxes(false);
  }
  // 誤検出（コマでない部分をコマと誤認識、絵の一部が別コマに重複検出等）を削除する。
  // 吹き出し/音声/口パク素材ごと消える取り消し不可の操作なので確認を挟む。
  async function removePanel(sid: string) {
    if (!window.confirm(`${sid} を削除します。中の吹き出し・音声・口パク素材もすべて消えます。よろしいですか？`)) return;
    await call("/review", { delete_shot_id: sid }, "delpanel");
  }
  // 手動で追加/移動したコマを含め、現在のbboxから読み順（右上→左、上→下）に自動整列し直す。
  async function resortPanels() {
    await call("/review", { resort_reading_order: true }, "resort");
  }
  // 読み順を1つ前/後ろへ（自動整列が正解と違う変則レイアウトの手動補正。同じページ内でのみ動く）。
  async function movePanel(sid: string, dir: "up" | "down") {
    await call("/review", { move_shot: { id: sid, dir } }, "movepanel");
  }

  function buildEdits() {
    return project.shots.map((s) => ({
      id: s.id,
      description: s.description,
      grade: s.grade ?? undefined,
      beat: s.beat ?? undefined,
      duration_sec: s.duration_sec ?? undefined,
      camera_type: s.camera.type,
      framing: s.framing,
      background_theme: s.background?.theme ?? "",
      // "custom"(手調整) は送らない＝route が panel_style を上書きせず温存する
      frame_style: frameIdOf(s.panel_style) === "custom" ? undefined : frameIdOf(s.panel_style),
      transition: s.transition_in?.kit ?? "cut",
      mouth_off: s.mouth?.disabled ?? false,
      bbox: s.bbox,
      // bubblesは配列を丸ごと差し替える（cardsと同じ方式）＝追加/削除がそのまま反映される。
      // サーバー生成済みのフィールド(erased_img等)もここで一緒に送って保持する
      // （送らないとルート側で消えてしまい、追加・削除のたびにG2/G3をやり直す羽目になる）。
      bubbles: s.bubbles.map((b) => ({
        text: b.text,
        kind: b.kind,
        bbox: b.bbox,
        speaker: b.speaker,
        emotion: b.emotion,
        sfx_prompt: b.sfx_prompt,
        erased_img: b.erased_img,
        erase_box: b.erase_box,
        reveal_timing: b.reveal_timing,
      })),
    }));
  }

  // ---- 検出枠のドラッグ編集（page座標で操作） ----
  function clamp(v: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(v, hi));
  }
  function startDrag(
    e: React.PointerEvent,
    kind: "move" | "resize",
    target: "bubble" | "panel",
    sid: string,
    bidx: number,
    bbox: [number, number, number, number],
    pageSize: { w: number; h: number }
  ) {
    if (target === "bubble" && !editBoxes) return;
    if (target === "panel" && !editPanelBoxes) return;
    if (!pageSize) return;
    const svg = (e.currentTarget as SVGElement).ownerSVGElement;
    if (!svg) return;
    e.preventDefault();
    e.stopPropagation();
    const r = svg.getBoundingClientRect();
    dragRef.current = {
      target,
      kind,
      sid,
      bidx,
      cx: e.clientX,
      cy: e.clientY,
      orig: [...bbox] as [number, number, number, number],
      sx: pageSize.w / r.width,
      sy: pageSize.h / r.height,
      pw: pageSize.w,
      ph: pageSize.h,
    };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.cx) * d.sx;
    const dy = (e.clientY - d.cy) * d.sy;
    let [x, y, w, h] = d.orig;
    if (d.kind === "move") {
      x = clamp(x + dx, 0, d.pw - w);
      y = clamp(y + dy, 0, d.ph - h);
    } else {
      w = clamp(w + dx, 8, d.pw - x);
      h = clamp(h + dy, 8, d.ph - y);
    }
    const nb: [number, number, number, number] = [
      Math.round(x),
      Math.round(y),
      Math.round(w),
      Math.round(h),
    ];
    if (d.target === "panel") patchShot(d.sid, { bbox: nb });
    else patchBubble(d.sid, d.bidx, { bbox: nb });
  }
  function endDrag() {
    dragRef.current = null;
  }

  const saveOnly = () => call("/review", { shots: buildEdits(), cards: project.cards }, "save");
  const approve = () => call("/review", { shots: buildEdits(), cards: project.cards, approve: true }, "approve");

  // ---- 文字カード（演出D/E） ----
  function addCard() {
    setProject((p) => ({
      ...p,
      cards: [
        ...p.cards,
        {
          id: `card_${Date.now()}`,
          role: "title",
          template: "title_default",
          at_start: true,
          after_shot: null,
          dur_sec: 2.5,
          lines: ["タイトル"],
          logo_asset: null,
          narration_voice: null,
        },
      ],
    }));
  }
  function patchCard(idx: number, patch: Partial<Project["cards"][number]>) {
    setProject((p) => ({ ...p, cards: p.cards.map((c, i) => (i === idx ? { ...c, ...patch } : c)) }));
  }
  function removeCard(idx: number) {
    setProject((p) => ({ ...p, cards: p.cards.filter((_, i) => i !== idx) }));
  }

  function patchCast(sid: string, patch: Partial<Project["voice_cast"][string]>) {
    setProject((p) => ({
      ...p,
      voice_cast: { ...p.voice_cast, [sid]: { ...p.voice_cast[sid], ...patch } },
    }));
  }
  function deleteCast(sid: string) {
    setProject((p) => {
      const vc = { ...p.voice_cast };
      delete vc[sid];
      return { ...p, voice_cast: vc };
    });
  }
  // AIが人物を取りこぼした/1人に統合してしまった時の受け皿。新しい話者IDを発行して
  // 既定の声を割り当てる。戻り値のIDをそのまま吹き出しのspeaker選択に使える。
  function addCast(): string {
    let n = 1;
    while (project.voice_cast[`speaker_${n}`]) n++;
    const sid = `speaker_${n}`;
    setProject((p) => ({
      ...p,
      voice_cast: {
        ...p.voice_cast,
        [sid]: { voice_id: "f_calm", speed: 1.0, pitch: 0, tone: "normal", age: "standard" },
      },
    }));
    return sid;
  }
  // 複数のPOSTを順に実行する共通ヘルパー。各ステップの結果でproject stateを更新するので、
  // 次のステップは常に最新状態（直前の保存内容）を見て動く。
  async function postSeq(steps: Array<[path: string, body?: unknown]>) {
    for (const [path, body] of steps) {
      const res = await fetch(`/api/projects/${id}${path}`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      if (!res.ok || json.ok === false) throw new Error(json.error || "失敗");
      if (json.project) {
        setProject(json.project);
        setRestored(false);
      }
    }
  }

  // 「配役を保存」：画面上の編集（セリフ・カード・配役）を丸ごと保存する。
  // voice_castだけでなくshots/cardsも一緒に送らないと、セリフの直し忘れが起きるため。
  const saveCast = async () => {
    setBusy("savecast");
    setErr(null);
    try {
      await postSeq([["/review", { shots: buildEdits(), cards: project.cards, voice_cast: project.voice_cast }]]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // 「この声で再生成（G3）」：動画は作り直さず音声だけ素早く聴きたい時用。
  // こちらも先に画面上の編集（セリフ含む）を保存してからG3を実行する
  // （保存せずにG3だけ叩くと、直したセリフではなく古い保存済みセリフで音声が作られてしまうため）。
  async function regenerateVoice() {
    setBusy("g3");
    setErr(null);
    try {
      await postSeq([
        ["/review", { shots: buildEdits(), cards: project.cards, voice_cast: project.voice_cast }],
        ["/g3"],
      ]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // 編集を動画に一括反映：保存 → 文字消し(G2) → 音声生成(G3) → 書き出し(G4)
  async function applyAndRender() {
    setBusy("apply");
    setErr(null);
    try {
      await postSeq([
        [
          "/review",
          {
            shots: buildEdits(),
            cards: project.cards,
            voice_cast: project.voice_cast,
            delivery: project.meta.delivery,
          },
        ],
        ["/g2"], // 青枠(吹き出し枠)の編集を文字消しに反映
        ["/g3"], // 話者・感情・文字(カタカナ等)を音声に反映
        ["/g4"], // 動画を書き出し
      ]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // G0〜G3をまとめて自動実行（承認は機械的な追認なので人の手を挟まない）。
  // 完了後、人はここで初めて「チェックと編集」（青枠の位置・話者/声・演出）に集中できる。
  // G4(書き出し)だけは編集後に「▶編集を動画に反映」で明示的に行う。
  // G0〜G3を自動連続実行。既に完了している工程はスキップするので、途中失敗・リロード後に
  // 再度押しても「続きから」再開する（＝押せる操作が常に1つある状態を保つ）。
  async function runAutoPipeline() {
    setBusy("auto");
    setErr(null);
    let latest = project; // setProjectは次のレンダーまで反映されないので、ローカルに最新状態を持つ
    try {
      const post = async (path: string, body: unknown, label: string) => {
        setAutoStep(label);
        const res = await fetch(`/api/projects/${id}${path}`, {
          method: "POST",
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const json = await res.json();
        if (!res.ok || json.ok === false) throw new Error(json.error || "失敗");
        if (json.project) {
          latest = json.project;
          setProject(json.project);
          setRestored(false);
        }
      };
      if (latest.pipeline.G0.state !== "done")
        await post("/g0", undefined, "1/5 コマを検出・OCR中…");
      if (latest.pipeline.G1.state !== "done")
        await post("/g1", undefined, "2/5 演出コンテを設計中…");
      if (!latest.pipeline.G1.approved)
        await post("/review", { approve: true }, "3/5 承認処理中…");
      if (latest.pipeline.G2.state !== "done")
        await post("/g2", undefined, "4/5 文字を消去中…");
      if (latest.pipeline.G3.state !== "done")
        await post("/g3", undefined, "5/5 声・音声を生成中…");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setAutoStep(null);
    }
  }
  // G0〜G3がまだ揃っていない（初回未実行・途中失敗・リロード等）かどうか。
  // trueの間は主要操作に常に「①自動で作成する/続きを作成する」を出し、詰みを防ぐ。
  const autoPipelineIncomplete =
    project.pipeline.G0.state !== "done" ||
    project.pipeline.G1.state !== "done" ||
    !project.pipeline.G1.approved ||
    project.pipeline.G2.state !== "done" ||
    project.pipeline.G3.state !== "done";

  return (
    <div style={{ marginTop: 12 }}>
      {restored && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            background: "rgba(110,168,254,0.12)",
            border: "1px solid var(--accent)",
            borderRadius: 8,
            padding: "9px 14px",
            marginBottom: 14,
            fontSize: 13,
          }}
        >
          <span>
            💾 前回の<strong>未保存の編集</strong>を復元しました。問題なければ「修正を保存」してください。
          </span>
          <button
            onClick={discardDraft}
            style={{
              marginLeft: "auto",
              padding: "4px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            破棄してサーバ保存版に戻す
          </button>
        </div>
      )}
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: "4px 0" }}>
          {project.meta.title || "(無題)"}{" "}
          <span style={{ color: "var(--muted)", fontSize: 13 }}>{id}</span>
        </h1>
        <div
          style={{
            color: "var(--muted)",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span>画角</span>
          <select
            value={project.meta.delivery}
            onChange={(e) =>
              setDelivery(e.target.value as Project["meta"]["delivery"])
            }
            disabled={busy === "delivery"}
            style={{
              background: "var(--panel-2)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "3px 6px",
              fontSize: 13,
            }}
          >
            <option value="vertical">9:16（縦）</option>
            <option value="square">1:1（正方形）</option>
            <option value="horizontal">16:9（横）</option>
          </select>
          {busy === "delivery" && <span>保存中…</span>}
          <span>／ 背景テーマ</span>
          <select
            value={project.meta.theme ?? "letterbox_black"}
            onChange={(e) => setTheme(e.target.value)}
            disabled={busy === "theme"}
            style={{
              background: "var(--panel-2)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "3px 6px",
              fontSize: 13,
            }}
          >
            {Object.entries(BACKGROUND_THEMES).map(([k, t]) => (
              <option key={k} value={k}>
                {t.label}
              </option>
            ))}
          </select>
          {busy === "theme" && <span>保存中…</span>}
          <span>
            ／ 目標尺 {project.meta.target_duration_sec}s ／ グレード方針{" "}
            {project.meta.grade_policy}
          </span>
        </div>
      </header>

      {/* === 主要操作（普段はこれだけ） === */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        {autoPipelineIncomplete ? (
          <>
            <button onClick={runAutoPipeline} disabled={!!busy} style={primaryBtn(!!busy)}>
              {busy === "auto"
                ? autoStep || "自動生成中…"
                : hasShots
                ? "① 続きを自動で作成する"
                : "① 自動で作成する（解析・演出・文字消し・音声）"}
            </button>
            {hasShots && busy !== "auto" && (
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                前回はここで止まっています。押すと続きから再開します（最初からやり直しません）。
              </span>
            )}
          </>
        ) : (
          <>
            <button
              onClick={applyAndRender}
              disabled={!!busy}
              style={{ ...primaryBtn(!!busy), padding: "11px 18px" }}
              title="編集（画角・背景・額装・登場・話者・文字・口パク等）を保存して動画を書き出します。"
            >
              {busy === "apply" ? "反映中…（文字消し→音声→書き出し 1〜2分）" : "▶ 編集を動画に反映"}
            </button>
            <button
              onClick={() => call("/mouth", {}, "mouth")}
              disabled={!!busy}
              style={btn(!!busy)}
              title="口が見える話者コマに「閉じ／半開き／開き」の口素材を生成し、音量に合わせて口パクさせます（生成後に「▶編集を動画に反映」で動画化）。"
            >
              {busy === "mouth" ? "口パク生成中…(1コマ1〜2分)" : "👄 口パクを生成"}
            </button>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              動画：{project.outputs.demo_mp4 ? "書き出し済み ✓" : "未書き出し"}　/　編集を変えたら「▶ 編集を動画に反映」を押す
            </span>
          </>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          disabled={!!busy}
          style={{ ...btn(false), fontSize: 12, padding: "6px 10px" }}
          title="G0〜G4の個別実行・承認など（通常は不要）"
        >
          ⚙ 詳細操作 {showAdvanced ? "▲" : "▼"}
        </button>
      </div>

      {/* === 詳細操作（折りたたみ・通常は「▶編集を動画に反映」だけでOK） === */}
      {showAdvanced && (
        <div
          style={{
            marginBottom: 14,
            padding: "10px 12px",
            background: "var(--panel-2)",
            border: "1px solid var(--border)",
            borderRadius: 8,
          }}
        >
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            {(["G0", "G1", "G2", "G3", "G4"] as Gate[]).map((g) => (
              <GateBadge key={g} gate={g} project={project} />
            ))}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>
            各ステップを個別に実行（順番：解析→コンテ→承認→文字消し→音声→書き出し）。普段は使いません。
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => call("/g0", undefined, "g0")} disabled={!!busy} style={btn()}>
              {busy === "g0" ? "G0実行中…" : hasShots ? "G0 再実行（検出・OCR）" : "G0 実行（検出・OCR）"}
            </button>
            <button onClick={() => call("/g1", undefined, "g1")} disabled={!!busy || !hasShots} style={btn(!hasShots)}>
              {busy === "g1" ? "G1実行中…" : "G1 実行（コンテ生成）"}
            </button>
            <button onClick={saveOnly} disabled={!!busy || !hasShots} style={btn(!hasShots)}>
              {busy === "save" ? "保存中…" : "修正を保存（書き出さない）"}
            </button>
            <button onClick={approve} disabled={!!busy || !hasShots} style={btn(!!busy || !hasShots)}>
              {busy === "approve" ? "承認中…" : g1.approved ? "再承認" : "承認（レビューゲート）"}
            </button>
            <button
              onClick={() => call("/g2", undefined, "g2")}
              disabled={!!busy || !g1.approved}
              style={btn(!g1.approved)}
              title={g1.approved ? "" : "先にG1を承認してください"}
            >
              {busy === "g2" ? "G2実行中…" : "G2 文字消し"}
            </button>
            <button
              onClick={() => call("/g3", undefined, "g3")}
              disabled={!!busy || !g1.approved}
              style={btn(!g1.approved)}
              title={g1.approved ? "" : "先にG1を承認してください"}
            >
              {busy === "g3" ? "G3実行中…" : "G3 音声"}
            </button>
            <button
              onClick={() => call("/g4", undefined, "g4")}
              disabled={!!busy || !g1.approved}
              style={btn(!g1.approved)}
              title={g1.approved ? "" : "先にG1を承認してください"}
            >
              {busy === "g4" ? "書き出し中…" : "G4 書き出し（mp4）"}
            </button>
          </div>
        </div>
      )}

      {err && (
        <div
          style={{
            color: "#ff8080",
            background: "#2a1414",
            border: "1px solid #5a2a2a",
            borderRadius: 6,
            padding: "8px 12px",
            marginBottom: 14,
            fontSize: 13,
          }}
        >
          {err}
        </div>
      )}


      {/* 演出D/E：文字カード（タイトル/アイキャッチ/ナレ） */}
      <section
        style={{
          marginBottom: 16,
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "12px 16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
          <h2 style={{ fontSize: 14, margin: 0 }}>文字カード（タイトル / アイキャッチ / ナレ）</h2>
          <button onClick={addCard} disabled={!!busy} style={{ ...btn(!!busy), fontSize: 12, padding: "5px 10px" }}>
            ＋ カード追加
          </button>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            「修正を保存」または「▶ 編集を動画に反映」で確定。冒頭/コマの後に差し込めます。
          </span>
        </div>
        {project.cards.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            カードなし。G1（コンテ）で自動提案、または「＋ カード追加」で作成。
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {project.cards.map((c, idx) => (
              <div
                key={c.id}
                style={{ display: "grid", gap: 6, border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px" }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <select
                    value={c.template}
                    onChange={(e) => {
                      const t = CARD_TEMPLATES[e.target.value];
                      patchCard(idx, { template: e.target.value, role: (t?.role ?? c.role) as typeof c.role });
                    }}
                    style={input}
                  >
                    {Object.entries(CARD_TEMPLATES).map(([k, t]) => (
                      <option key={k} value={k}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <span style={labelText}>配置</span>
                  <select
                    value={c.at_start ? "__start" : c.after_shot ?? "__start"}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "__start") patchCard(idx, { at_start: true, after_shot: null });
                      else patchCard(idx, { at_start: false, after_shot: v });
                    }}
                    style={input}
                  >
                    <option value="__start">冒頭</option>
                    {project.shots.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.id} の後
                      </option>
                    ))}
                  </select>
                  <span style={labelText}>尺</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0.5"
                    value={c.dur_sec}
                    onChange={(e) => patchCard(idx, { dur_sec: Number(e.target.value) || 2.5 })}
                    style={{ ...input, width: 64 }}
                  />
                  <span style={{ ...labelText }}>秒</span>
                  <button
                    onClick={() => removeCard(idx)}
                    disabled={!!busy}
                    style={{ ...btn(!!busy), marginLeft: "auto", fontSize: 12, padding: "5px 9px" }}
                    title="このカードを削除"
                  >
                    ✕
                  </button>
                </div>
                <textarea
                  value={c.lines.join("\n")}
                  onChange={(e) => patchCard(idx, { lines: e.target.value.split("\n") })}
                  rows={2}
                  placeholder="表示テキスト（改行で複数行／縦書きテンプレは1行=1列）"
                  style={{ ...input, width: "100%", resize: "vertical", fontFamily: "inherit" }}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <section
          style={{
            marginBottom: 16,
            background: "var(--panel-2)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 14,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <h2 style={{ fontSize: 14, margin: 0 }}>
              声の配役（話者ごとに 声・感情・速さ を選ぶ）
            </h2>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={addCast}
                disabled={!!busy}
                style={{ ...btn(!!busy), fontSize: 12, padding: "5px 10px" }}
                title="AIが人物を見落とした/1人に混同した時に、新しい話者を手動で追加できます"
              >
                ＋ 話者を追加
              </button>
              <button onClick={saveCast} disabled={!!busy} style={btn()} title="今の編集（セリフ・カード・配役）を保存します（音声は作り直しません）">
                {busy === "savecast" ? "保存中…" : "配役を保存"}
              </button>
              <button
                onClick={regenerateVoice}
                disabled={!!busy}
                style={primaryBtn(!!busy)}
                title="今の編集を保存してから、この配役で音声だけ作り直します（動画は作り直しません）"
              >
                {busy === "g3" ? "音声生成中…" : "この声で再生成（G3）"}
              </button>
            </div>
          </div>
          {Object.keys(project.voice_cast).length === 0 && (
            <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 10px" }}>
              話者はまだいません。「① 自動で作成する」を実行するとAIが自動で登場人物ごとに声を割り当てます。人物の見落としに気づいたら、上の「＋ 話者を追加」で手動で足せます。
            </p>
          )}
          <div style={{ display: "grid", gap: 8 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "76px 1fr 52px 54px 78px 78px 26px",
                gap: 6,
                fontSize: 11,
                color: "var(--muted)",
              }}
            >
              <span>話者</span>
              <span>声優</span>
              <span>速さ</span>
              <span>ピッチ</span>
              <span>トーン</span>
              <span>年齢</span>
              <span />
            </div>
            {Object.entries(project.voice_cast).map(([sid, c]) => (
              <div
                key={sid}
                style={{
                  display: "grid",
                  gridTemplateColumns: "76px 1fr 52px 54px 78px 78px 26px",
                  gap: 6,
                  alignItems: "center",
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600 }}>{sid}</span>
                <select
                  value={c.voice_id}
                  onChange={(e) => patchCast(sid, { voice_id: e.target.value })}
                  style={input}
                >
                  {VOICE_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={0.5}
                  max={2}
                  step={0.1}
                  value={c.speed}
                  onChange={(e) => patchCast(sid, { speed: Number(e.target.value) })}
                  style={input}
                  title="速さ(0.5〜2)"
                />
                <input
                  type="number"
                  min={-8}
                  max={8}
                  step={1}
                  value={c.pitch ?? 0}
                  onChange={(e) => patchCast(sid, { pitch: Number(e.target.value) })}
                  style={input}
                  title="ピッチ：-で低く / +で高く（0=既定）"
                />
                <select
                  value={c.tone ?? "normal"}
                  onChange={(e) => patchCast(sid, { tone: e.target.value })}
                  style={input}
                  title="トーン（基本の抑揚）"
                >
                  {TONES.map((t) => (
                    <option key={t} value={t}>
                      {TONE_LABELS[t] ?? t}
                    </option>
                  ))}
                </select>
                <select
                  value={c.age ?? "standard"}
                  onChange={(e) => patchCast(sid, { age: e.target.value })}
                  style={input}
                  title="年齢感（Geminiの男声で有効）"
                >
                  {AGES.map((a) => (
                    <option key={a} value={a}>
                      {AGE_LABELS[a] ?? a}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => deleteCast(sid)}
                  disabled={!!busy}
                  title="この配役を削除（保存で確定）"
                  style={{
                    background: "transparent",
                    color: "#ff8080",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 14,
                    padding: "6px 0",
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </section>

      {project.outputs.demo_mp4 && (
        <section style={{ marginBottom: 18 }}>
          <h2 style={{ fontSize: 14, color: "var(--ok)", marginBottom: 8 }}>
            完成動画（DEMO mp4）
          </h2>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            // ?v=cost_log.length で再書き出しのたびにURLを変える＝古いmp4のキャッシュを掴まない
            // (key も付け替えて video 要素を作り直し、新サイズ/新内容を確実に再読込)
            key={`demo-${project.cost_log.length}`}
            controls
            src={`/api/assets/${id}/${project.outputs.demo_mp4}?v=${project.cost_log.length}`}
            style={{
              maxWidth: 360,
              width: "100%",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "#000",
            }}
          />
          <div style={{ marginTop: 6 }}>
            <a
              href={`/api/assets/${id}/${project.outputs.demo_mp4}?v=${project.cost_log.length}`}
              download
              style={{ fontSize: 13, color: "var(--accent)" }}
            >
              ⬇ mp4をダウンロード
            </a>
          </div>
        </section>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 480px) 1fr", gap: 24 }}>
        {/* 左: 画像＋検出オーバーレイ */}
        <div style={{ position: "sticky", top: 16, alignSelf: "start" }}>
          <label
            style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8, fontSize: 13 }}
          >
            <input
              type="checkbox"
              checked={showOverlay}
              onChange={(e) => setShowOverlay(e.target.checked)}
            />
            検出枠を表示（緑=light / 黄=standard / 赤=advanced / 灰=未設定、青破線=吹き出し）
          </label>
          <label
            style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8, fontSize: 13 }}
          >
            <input
              type="checkbox"
              checked={editBoxes}
              onChange={(e) => {
                setEditBoxes(e.target.checked);
                if (e.target.checked) setEditPanelBoxes(false);
              }}
            />
            吹き出し枠を編集（青枠をドラッグで移動／右下の角でリサイズ → 「▶編集を動画に反映」）
          </label>
          <label
            style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8, fontSize: 13 }}
          >
            <input
              type="checkbox"
              checked={editPanelBoxes}
              onChange={(e) => {
                setEditPanelBoxes(e.target.checked);
                if (e.target.checked) setEditBoxes(false);
              }}
            />
            コマ枠を編集（AIの検出がズレている時に、コマの外枠自体をドラッグで移動／右下の角でリサイズ → 「▶編集を動画に反映」）
          </label>
          {editPanelBoxes && (
            <button
              onClick={resortPanels}
              disabled={!!busy}
              style={{ ...btn(!!busy), fontSize: 12, padding: "5px 10px", marginBottom: 8 }}
              title="コマを追加/移動した後、今の位置から読み順（右上→左、上→下）に番号を自動で振り直します"
            >
              {busy === "resort" ? "整列中…" : "🔀 順番を自動整列"}
            </button>
          )}
          {(() => {
            // 多ページ：pages があればページ別に画像＋オーバーレイ。無ければ単一ページ(従来)。
            const pagesToShow =
              project.meta.pages && project.meta.pages.length > 0
                ? [...project.meta.pages]
                    .sort((a, b) => a.index - b.index)
                    .map((p) => ({ id: p.id, url: `/api/assets/${id}/${p.source_image}` }))
                : [{ id: "", url: assetUrl }];
            const multi = pagesToShow.length > 1;
            return pagesToShow.map((page, pi) => {
              const sz = sizes[page.id];
              const pageShots = project.shots.filter((s) => (s.page_id || "") === page.id);
              return (
                <div key={page.id || "single"} style={{ marginBottom: multi ? 14 : 0 }}>
                  {multi && (
                    <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
                      ページ {pi + 1}（{pageShots.length}コマ）
                    </div>
                  )}
                  <div style={{ position: "relative", display: "inline-block", lineHeight: 0 }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      ref={(el) => noteSize(page.id, el)}
                      src={page.url}
                      alt={`page-${pi + 1}`}
                      style={{ width: "100%", maxWidth: 480, height: "auto", borderRadius: 6 }}
                      onLoad={(e) => {
                        // currentTarget は同期で読む（setState の更新関数内では null 化される）
                        const w = e.currentTarget.naturalWidth;
                        const h = e.currentTarget.naturalHeight;
                        setSizes((s) => ({ ...s, [page.id]: { w, h } }));
                      }}
                    />
                    {(showOverlay || editBoxes || editPanelBoxes) && sz && (
                      <svg
                        viewBox={`0 0 ${sz.w} ${sz.h}`}
                        preserveAspectRatio="none"
                        onPointerMove={onPointerMove}
                        onPointerUp={endDrag}
                        onPointerLeave={endDrag}
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: "100%",
                          height: "100%",
                          pointerEvents: editBoxes || editPanelBoxes ? "auto" : "none",
                          touchAction: editBoxes || editPanelBoxes ? "none" : "auto",
                        }}
                      >
                        {pageShots.map((s) => {
                          const gi = project.shots.indexOf(s); // 章通しのコマ番号
                          const [x, y, w, h] = s.bbox;
                          const hl = highlightShotId === s.id;
                          const c = hl ? "#ffd666" : (s.grade && GRADE_COLOR[s.grade]) || "#6b7280";
                          return (
                            <g key={s.id}>
                              <rect
                                x={x}
                                y={y}
                                width={w}
                                height={h}
                                fill={hl ? "rgba(255,214,102,0.14)" : editPanelBoxes ? "rgba(224,182,90,0.08)" : "none"}
                                stroke={c}
                                strokeWidth={hl ? 4 : 2}
                                vectorEffect="non-scaling-stroke"
                                style={{ cursor: editPanelBoxes ? "move" : "pointer", pointerEvents: "all" }}
                                onPointerDown={(e) => {
                                  if (editPanelBoxes) startDrag(e, "move", "panel", s.id, -1, s.bbox as [number, number, number, number], sz);
                                }}
                                onClick={() => !editPanelBoxes && focusShot(s.id)}
                              />
                              <text x={x + 6} y={y + 26} fill={c} fontSize={Math.max(18, sz.w / 45)} style={{ pointerEvents: "none" }}>
                                {gi + 1}
                              </text>
                              {editPanelBoxes && (
                                <rect
                                  x={x + w - 22}
                                  y={y + h - 22}
                                  width={22}
                                  height={22}
                                  fill={c}
                                  style={{ cursor: "nwse-resize", pointerEvents: "all" }}
                                  onPointerDown={(e) =>
                                    startDrag(e, "resize", "panel", s.id, -1, s.bbox as [number, number, number, number], sz)
                                  }
                                />
                              )}
                              {s.bubbles.map((b, j) =>
                                b.bbox ? (
                                  <g key={j}>
                                    <rect
                                      x={b.bbox[0]}
                                      y={b.bbox[1]}
                                      width={b.bbox[2]}
                                      height={b.bbox[3]}
                                      fill={editBoxes ? "rgba(110,168,254,0.18)" : "none"}
                                      stroke="#6ea8fe"
                                      strokeWidth={editBoxes ? 2 : 1.5}
                                      strokeDasharray={editBoxes ? undefined : "4 3"}
                                      vectorEffect="non-scaling-stroke"
                                      style={{ cursor: editBoxes ? "move" : "pointer", pointerEvents: editPanelBoxes ? "none" : "all" }}
                                      onPointerDown={(e) => {
                                        if (editBoxes) startDrag(e, "move", "bubble", s.id, j, b.bbox as [number, number, number, number], sz);
                                      }}
                                      onClick={() => !editBoxes && !editPanelBoxes && focusShot(s.id)}
                                    />
                                    {/* 吹き出し番号(B1,B2…)。右側の吹き出し行と同じ番号で1対1対応させる */}
                                    <text
                                      x={b.bbox[0] + 3}
                                      y={b.bbox[1] + Math.min(16, b.bbox[3])}
                                      fill="#6ea8fe"
                                      fontSize={Math.max(12, sz.w / 70)}
                                      style={{ pointerEvents: "none", fontWeight: 700 }}
                                    >
                                      B{j + 1}
                                    </text>
                                    {editBoxes && (
                                      <rect
                                        x={b.bbox[0] + b.bbox[2] - 18}
                                        y={b.bbox[1] + b.bbox[3] - 18}
                                        width={18}
                                        height={18}
                                        fill="#6ea8fe"
                                        style={{ cursor: "nwse-resize", pointerEvents: "all" }}
                                        onPointerDown={(e) =>
                                          startDrag(e, "resize", "bubble", s.id, j, b.bbox as [number, number, number, number], sz)
                                        }
                                      />
                                    )}
                                  </g>
                                ) : null
                              )}
                            </g>
                          );
                        })}
                      </svg>
                    )}
                  </div>
                  {editPanelBoxes && (
                    <button
                      onClick={() => addPanel(page.id)}
                      disabled={!!busy}
                      style={{ ...btn(!!busy), fontSize: 12, padding: "5px 10px", marginTop: 6 }}
                      title="G0が見落としたコマをこのページに追加します（中央に小さく置くので、追加後にドラッグ/リサイズで位置を合わせてください）"
                    >
                      {busy === "addpanel" ? "追加中…" : "＋ コマを追加"}
                    </button>
                  )}
                </div>
              );
            });
          })()}
        </div>

        {/* 右: コマ編集 */}
        <div style={{ display: "grid", gap: 12 }}>
          {!hasShots && (
            <div style={{ color: "var(--muted)" }}>
              「① 自動で作成する」を押すと、コマ検出から演出・文字消し・音声まで自動で作成し、ここに表示します（1〜3分）。
            </div>
          )}
          {project.shots.map((s, i) => (
            <div
              key={s.id}
              id={`shot-card-${s.id}`}
              style={{
                background: "var(--panel-2)",
                border: highlightShotId === s.id ? "1px solid #ffd666" : "1px solid var(--border)",
                boxShadow: highlightShotId === s.id ? "0 0 0 3px rgba(255,214,102,0.25)" : undefined,
                borderRadius: 8,
                padding: 14,
                transition: "box-shadow 0.2s, border-color 0.2s",
                scrollMarginTop: 16,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div
                  style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                  onClick={() => focusShot(s.id)}
                  title="このコマの左の画像枠を光らせます"
                >
                  <span
                    style={{
                      background: (s.grade && GRADE_COLOR[s.grade]) || "#6b7280",
                      color: "#0b0e14",
                      fontWeight: 700,
                      borderRadius: 4,
                      padding: "1px 8px",
                      fontSize: 13,
                    }}
                  >
                    {i + 1}
                  </span>
                  <strong>{s.id}</strong>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  {(() => {
                    const samePage = (a: number) =>
                      a >= 0 && a < project.shots.length && (project.shots[a].page_id || "") === (s.page_id || "");
                    const canUp = samePage(i - 1);
                    const canDown = samePage(i + 1);
                    return (
                      <>
                        <button
                          onClick={() => movePanel(s.id, "up")}
                          disabled={!!busy || !canUp}
                          style={{ ...btn(!!busy || !canUp), fontSize: 12, padding: "3px 8px" }}
                          title="読み順を1つ前へ（自動の順番判定が実際の読み順と違う時の手動補正）"
                        >
                          ▲ 前へ
                        </button>
                        <button
                          onClick={() => movePanel(s.id, "down")}
                          disabled={!!busy || !canDown}
                          style={{ ...btn(!!busy || !canDown), fontSize: 12, padding: "3px 8px" }}
                          title="読み順を1つ後ろへ（自動の順番判定が実際の読み順と違う時の手動補正）"
                        >
                          ▼ 後へ
                        </button>
                        <button
                          onClick={() => removePanel(s.id)}
                          disabled={!!busy}
                          style={{ ...btn(!!busy), fontSize: 12, padding: "3px 8px", color: "var(--muted)" }}
                          title="このコマ自体を削除します（誤検出/重複したコマ用。中の吹き出し・音声・口パク素材も一緒に消えます）"
                        >
                          ✕ コマを削除
                        </button>
                      </>
                    );
                  })()}
                </div>
              </div>

              <input
                type="text"
                value={s.description}
                onChange={(e) => patchShot(s.id, { description: e.target.value })}
                placeholder="コマの説明"
                style={{ ...input, width: "100%", marginBottom: 10 }}
              />

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 90px 1fr",
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <Select
                  label="グレード"
                  value={s.grade ?? ""}
                  options={GRADES}
                  onChange={(v) => patchShot(s.id, { grade: (v || null) as never })}
                />
                <Select
                  label="ビート"
                  value={s.beat ?? ""}
                  options={BEATS}
                  onChange={(v) => patchShot(s.id, { beat: (v || null) as never })}
                />
                <label style={fieldLabel}>
                  <span style={labelText}>尺(秒)</span>
                  <input
                    type="number"
                    step="0.1"
                    value={s.duration_sec ?? ""}
                    onChange={(e) =>
                      patchShot(s.id, {
                        duration_sec: e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                    style={input}
                  />
                </label>
                <Select
                  label="カメラ"
                  value={s.camera.type}
                  options={CAMERA_TYPES}
                  onChange={(v) =>
                    patchShot(s.id, { camera: { ...s.camera, type: v as never } })
                  }
                />
              </div>
              {typeof s.camera.params?.reason === "string" && s.camera.params.reason && (
                <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 8 }}>
                  カメラ理由: {String(s.camera.params.reason)}
                </div>
              )}

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "100px 1fr",
                  gap: 8,
                  marginBottom: 8,
                  alignItems: "center",
                }}
              >
                <span style={labelText}>コマの見せ方</span>
                <select
                  value={s.framing}
                  onChange={(e) => patchShot(s.id, { framing: e.target.value as never })}
                  style={input}
                >
                  {FRAMING_LABELS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* 演出B：背景テーマ（コマ別上書き）＋額装 */}
              <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={labelText}>背景</span>
                <select
                  value={s.background?.theme ?? ""}
                  onChange={(e) =>
                    patchShot(s.id, {
                      background: { ...(s.background ?? { theme: "", override_colors: [] }), theme: e.target.value },
                    })
                  }
                  style={input}
                >
                  <option value="">
                    テーマに従う（{BACKGROUND_THEMES[project.meta.theme ?? "letterbox_black"]?.label ?? "—"}）
                  </option>
                  {Object.entries(BACKGROUND_THEMES).map(([k, t]) => (
                    <option key={k} value={k}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <span style={labelText}>額装</span>
                <select
                  value={frameIdOf(s.panel_style)}
                  onChange={(e) => patchShot(s.id, { panel_style: resolveFramePreset(e.target.value) })}
                  style={input}
                >
                  {frameIdOf(s.panel_style) === "custom" && (
                    <option value="custom" disabled>
                      （カスタム）
                    </option>
                  )}
                  {Object.entries(PANEL_FRAME_PRESETS).map(([k, f]) => (
                    <option key={k} value={k}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <span style={labelText}>登場</span>
                <select
                  value={s.transition_in?.kit ?? "cut"}
                  onChange={(e) =>
                    patchShot(s.id, {
                      transition_in: { ...(s.transition_in ?? { kit: "cut", dur_sec: 0, color: null }), kit: e.target.value },
                    })
                  }
                  style={input}
                >
                  {Object.entries(TRANSITION_KITS).map(([k, t]) => (
                    <option key={k} value={k}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ ...labelText, fontWeight: 600 }}>
                      吹き出し / OCR（{s.bubbles.length}）
                    </span>
                    <button
                      onClick={() => addBubble(s.id)}
                      disabled={!!busy}
                      style={{ ...btn(!!busy), marginLeft: "auto", fontSize: 11, padding: "3px 8px" }}
                      title="検出漏れの吹き出しをこのコマに追加（追加後、左の画像で枠をドラッグ/リサイズして位置合わせ）"
                    >
                      ＋ 吹き出しを追加
                    </button>
                  </div>
                  {s.bubbles.length === 0 && (
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>吹き出しなし</span>
                  )}
                  {s.bubbles.map((b, j) => {
                    const v = s.voice.find((x) => x.bubble_index === j);
                    const sfxClip = s.sfx.find((x) => x.bubble_index === j);
                    return (
                      <div key={j} style={{ display: "grid", gap: 4 }}>
                        <div
                          style={{ display: "grid", gridTemplateColumns: "24px 110px 1fr auto", gap: 8, alignItems: "center" }}
                        >
                          {/* 左の画像の青枠と同じ番号（B1,B2…）。どの枠がこの行かを1対1で照合できる */}
                          <span style={{ fontSize: 11, color: "#6ea8fe", fontWeight: 700 }}>
                            B{j + 1}
                          </span>
                          <select
                            value={b.kind}
                            onChange={(e) =>
                              patchBubble(s.id, j, { kind: e.target.value as never })
                            }
                            style={input}
                            title="種別"
                          >
                            {BUBBLE_KINDS.map((k) => (
                              <option key={k} value={k}>
                                {KIND_LABELS[k] ?? k}
                              </option>
                            ))}
                          </select>
                          <input
                            type="text"
                            value={b.text}
                            onChange={(e) => patchBubble(s.id, j, { text: e.target.value })}
                            style={input}
                          />
                          <button
                            onClick={() => removeBubble(s.id, j)}
                            disabled={!!busy}
                            style={{ ...btn(!!busy), fontSize: 12, padding: "5px 9px" }}
                            title="この吹き出しを削除（誤検出の除去用）"
                          >
                            ✕
                          </button>
                        </div>
                        {SPEAKABLE.has(b.kind) ? (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              paddingLeft: 4,
                              flexWrap: "wrap",
                            }}
                          >
                            <span style={{ fontSize: 12 }}>🔊</span>
                            <select
                              value={b.speaker ?? ""}
                              onChange={(e) => {
                                if (e.target.value === "__add_new__") {
                                  const sid = addCast();
                                  patchBubble(s.id, j, { speaker: sid });
                                  return;
                                }
                                patchBubble(s.id, j, { speaker: e.target.value });
                              }}
                              style={{ ...input, width: "auto", fontSize: 11, padding: "3px 6px" }}
                              title="話者"
                            >
                              {!b.speaker && <option value="">（話者を選ぶ）</option>}
                              {Array.from(
                                new Set([
                                  ...Object.keys(project.voice_cast),
                                  ...(b.speaker ? [b.speaker] : []),
                                ])
                              ).map((sid) => (
                                <option key={sid} value={sid}>
                                  {sid}
                                </option>
                              ))}
                              <option value="__add_new__">＋ 新しい話者を追加…</option>
                            </select>
                            <select
                              value={b.emotion || "neutral"}
                              onChange={(e) => patchBubble(s.id, j, { emotion: e.target.value })}
                              style={{ ...input, width: "auto", fontSize: 11, padding: "3px 6px" }}
                              title="感情"
                            >
                              {EMOTIONS.map((em) => (
                                <option key={em} value={em}>
                                  {EMOTION_LABELS[em] ?? em}
                                </option>
                              ))}
                            </select>
                            {v ? (
                              <>
                                <span style={{ fontSize: 11, color: "var(--muted)" }}>
                                  {v.dur}s
                                </span>
                                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                                <audio
                                  controls
                                  preload="none"
                                  src={`/api/assets/${id}/${v.clip}`}
                                  style={{ height: 30, maxWidth: "100%" }}
                                />
                              </>
                            ) : (
                              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                                未生成（「▶編集を動画に反映」で作成）
                              </span>
                            )}
                          </div>
                        ) : b.kind === "sfx" ? (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              paddingLeft: 4,
                              flexWrap: "wrap",
                            }}
                          >
                            <span style={{ fontSize: 12 }}>🔊</span>
                            {sfxClip ? (
                              <>
                                <span style={{ fontSize: 11, color: "var(--muted)" }}>
                                  {sfxClip.dur.toFixed(1)}s
                                </span>
                                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                                <audio
                                  controls
                                  preload="none"
                                  src={`/api/assets/${id}/${sfxClip.clip}`}
                                  style={{ height: 30, maxWidth: "100%" }}
                                />
                              </>
                            ) : (
                              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                                効果音（「▶編集を動画に反映」で生成）
                              </span>
                            )}
                            <span
                              style={{ fontSize: 11, color: "var(--muted)", flexBasis: "100%" }}
                            >
                              「ドン」等、誰かの発声ではない環境音・衝撃音の書き文字はここ。「ぎゃあ」等キャラが発する叫びは種別「叫び声」に（配役した声で読み上げます）。
                            </span>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
              </div>

              {s.layers.background_inpainted && (
                <div style={{ marginTop: 10 }}>
                  <span style={{ ...labelText, fontWeight: 600 }}>
                    文字消し後（G2）
                  </span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/assets/${id}/${s.layers.background_inpainted}`}
                    alt="clean"
                    style={{
                      display: "block",
                      width: "100%",
                      maxWidth: 280,
                      borderRadius: 6,
                      marginTop: 4,
                      border: "1px solid var(--border)",
                    }}
                  />
                </div>
              )}

              {/* 口パク（話者コマ）：素材プレビュー＋「このコマは口パクしない」トグル（可逆） */}
              {s.mouth ? (
                <div style={{ marginTop: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <span style={{ ...labelText, fontWeight: 600 }}>
                      口パク（話者コマ{s.mouth.facing === "side" ? "・横顔" : ""}）
                    </span>
                    <label style={{ ...labelText, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={!!s.mouth.disabled}
                        onChange={(e) =>
                          patchShot(s.id, { mouth: { ...s.mouth!, disabled: e.target.checked } })
                        }
                      />
                      このコマは口パクしない（静止）
                    </label>
                  </div>
                  {s.mouth.open_img ? (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-end",
                        gap: 8,
                        marginTop: 4,
                        opacity: s.mouth.disabled ? 0.4 : 1,
                      }}
                    >
                      {(
                        [
                          ["閉じ", s.mouth.closed_img],
                          ["半開き", s.mouth.half_img],
                          ["開き", s.mouth.open_img],
                        ] as [string, string | null][]
                      ).map(([lbl, src]) => (
                        <div key={lbl} style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 2 }}>{lbl}</div>
                          {src ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={`/api/assets/${id}/${src}?v=${project.cost_log.length}`}
                              alt={lbl}
                              style={{ display: "block", width: 84, borderRadius: 6, border: "1px solid var(--border)" }}
                            />
                          ) : (
                            <div
                              style={{
                                width: 84,
                                height: 84,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: 10,
                                color: "var(--muted)",
                                border: "1px dashed var(--border)",
                                borderRadius: 6,
                              }}
                            >
                              なし
                            </div>
                          )}
                        </div>
                      ))}
                      <button
                        onClick={() => call("/mouth", { shot_id: s.id }, "mouth")}
                        disabled={!!busy}
                        style={{ ...btn(!!busy), fontSize: 12, padding: "6px 10px" }}
                        title="口素材が崩れていたら作り直します（AI生成なので時々失敗します）"
                      >
                        作り直す
                      </button>
                    </div>
                  ) : (
                    <div style={{ marginTop: 4, fontSize: 11, color: "var(--muted)", display: "flex", alignItems: "center", gap: 8 }}>
                      口パク素材なし（聞き手/未生成）。
                      <button
                        onClick={() => call("/mouth", { shot_id: s.id }, "mouth")}
                        disabled={!!busy || s.mouth.disabled}
                        style={{ ...btn(!!busy || s.mouth.disabled), fontSize: 12, padding: "4px 8px" }}
                        title="この顔に口パク素材を生成します"
                      >
                        生成する
                      </button>
                    </div>
                  )}
                </div>
              ) : s.voice.length > 0 && !s.mouth ? (
                <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
                  口が見えないコマ → 喋り中は体を小さく動かして表現します
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {/* コストログ */}
      {project.cost_log.length > 0 && (
        <section style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 14, color: "var(--muted)", marginBottom: 8 }}>
            コスト合計（APIコスト概算）
          </h2>
          {(() => {
            const JPY = 155; // 1ドルあたりの概算（表示用）
            const all = project.cost_log;
            const cumulative = all.reduce((t, c) => t + c.api_cost, 0);
            // この動画1本ぶん＝各ゲートの「最新の実行」だけを合計（再実行ぶんは含めない）
            const latestByGate = new Map<string, number>();
            for (const c of all) latestByGate.set(c.gate, c.api_cost);
            const perVideo = [...latestByGate.values()].reduce((t, v) => t + v, 0);
            const yen = (usd: number) => `¥${Math.round(usd * JPY).toLocaleString()}`;
            const card: React.CSSProperties = {
              flex: "1 1 220px",
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "12px 16px",
            };
            return (
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
                <div style={card}>
                  <div style={{ color: "var(--muted)", fontSize: 12 }}>この動画1本ぶん</div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>
                    ${perVideo.toFixed(3)}{" "}
                    <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 400 }}>
                      ≈ {yen(perVideo)}
                    </span>
                  </div>
                  <div style={{ color: "var(--muted)", fontSize: 11 }}>各ゲート最新の実行を合計</div>
                </div>
                <div style={card}>
                  <div style={{ color: "var(--muted)", fontSize: 12 }}>
                    累計（再実行ぶんも含む）
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>
                    ${cumulative.toFixed(3)}{" "}
                    <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 400 }}>
                      ≈ {yen(cumulative)}
                    </span>
                  </div>
                  <div style={{ color: "var(--muted)", fontSize: 11 }}>
                    これまでの全API呼び出し（{all.length}回）
                  </div>
                </div>
              </div>
            );
          })()}
          <h3 style={{ fontSize: 13, color: "var(--muted)", margin: "0 0 8px" }}>
            内訳（処理時間・APIコスト）
          </h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: "var(--muted)", textAlign: "left" }}>
                <th style={td}>ゲート</th>
                <th style={td}>秒</th>
                <th style={td}>$ (概算)</th>
                <th style={td}>メモ</th>
              </tr>
            </thead>
            <tbody>
              {project.cost_log.map((c, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={td}>{c.gate}</td>
                  <td style={td}>{c.elapsed_sec.toFixed(1)}</td>
                  <td style={td}>${c.api_cost.toFixed(4)}</td>
                  <td style={{ ...td, color: "var(--muted)" }}>{c.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function GateBadge({ gate, project }: { gate: Gate; project: Project }) {
  const g = project.pipeline[gate];
  const colors: Record<string, string> = {
    pending: "#6b7280",
    running: "#6ea8fe",
    done: "#5fd08a",
    error: "#ff7a7a",
  };
  const c = colors[g.state] || "#6b7280";
  return (
    <span
      style={{
        border: `1px solid ${c}`,
        color: c,
        borderRadius: 6,
        padding: "2px 10px",
        fontSize: 13,
      }}
    >
      {gate}: {g.state}
      {gate === "G1" && g.approved ? " ✓承認済" : ""}
    </span>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <label style={fieldLabel}>
      <span style={labelText}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={input}>
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

const input: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  padding: "7px 9px",
  fontSize: 13,
  width: "100%",
};
const fieldLabel: React.CSSProperties = { display: "grid", gap: 4 };
const labelText: React.CSSProperties = { fontSize: 12, color: "var(--muted)" };
const td: React.CSSProperties = { padding: "6px 8px" };

function btn(disabled = false): React.CSSProperties {
  return {
    background: "var(--panel-2)",
    color: disabled ? "var(--muted)" : "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "9px 14px",
    fontSize: 14,
    cursor: disabled ? "default" : "pointer",
  };
}
function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? "#3a4a6a" : "var(--accent)",
    color: "#0b0e14",
    border: "none",
    borderRadius: 6,
    padding: "9px 16px",
    fontSize: 14,
    fontWeight: 700,
    cursor: disabled ? "default" : "pointer",
  };
}
