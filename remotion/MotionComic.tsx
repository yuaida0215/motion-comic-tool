import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { Project, Shot } from "../lib/schema";
import type { CardTiming, ShotTiming, Timeline } from "../lib/timeline";
import { resolveBgTheme, bgFillToCss, resolveCardTemplate, resolveTransitionKit } from "../lib/presets";

export type MotionComicProps = {
  project: Project;
  assetBase: string; // 例: http://localhost:3100/api/assets/<id>
  timeline: Timeline;
};

export const MotionComic: React.FC<MotionComicProps> = ({
  project,
  assetBase,
  timeline,
}) => {
  const { fps } = useVideoConfig();
  const bgm = project.meta.bgm_track ? `${assetBase}/${project.meta.bgm_track}` : null;
  // 動画の先頭（frame 0）に来るのは、開始カードがあればそのカード、無ければ最初のコマ。
  // 先頭コマに「黒/白からのフェード」トランジションが付くと先頭フレームが真っ黒/真っ白になり
  // 「何も写っていない」状態になる（QuickTimeのポスター表示も黒）。→ 先頭セグメントは必ずカットイン。
  const hasStartCard = (timeline.cards ?? []).some((c) => c.startSec <= 0.01);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {timeline.shots.map((st, i) => {
        const shot = project.shots[i];
        if (!shot) return null;
        const from = Math.round(st.startSec * fps);
        const durationInFrames = Math.max(1, Math.round(st.durSec * fps));
        return (
          <Sequence key={st.id} from={from} durationInFrames={durationInFrames}>
            <ShotView
              shot={shot}
              st={st}
              assetBase={assetBase}
              metaTheme={project.meta.theme ?? "letterbox_black"}
              isFirst={i === 0 && !hasStartCard}
            />
          </Sequence>
        );
      })}
      {/* 演出D/E：タイトル/アイキャッチ/ナレ文字カード */}
      {(timeline.cards ?? []).map((c) => {
        const from = Math.round(c.startSec * fps);
        const durationInFrames = Math.max(1, Math.round(c.durSec * fps));
        return (
          <Sequence key={c.id} from={from} durationInFrames={durationInFrames}>
            <CardView card={c} />
          </Sequence>
        );
      })}
      {bgm && <Audio src={bgm} volume={0.15} />}
    </AbsoluteFill>
  );
};

const CardView: React.FC<{ card: CardTiming }> = ({ card }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const durF = Math.max(1, Math.round(card.durSec * fps));
  const tpl = resolveCardTemplate(card.template);
  const ts = tpl.textStyle;
  const bgCss = bgFillToCss(resolveBgTheme(tpl.bg).fill);
  const fontSize = Math.round((height * ts.sizePct) / 100);
  const vertical = ts.writingMode === "vertical";

  // 登場アニメ：フェード（共通）＋ slide は下から、最後は軽くフェードアウト。
  const fadeIn = interpolate(frame, [0, Math.round(0.4 * fps)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fadeOut = interpolate(frame, [durF - Math.round(0.3 * fps), durF], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const opacity = Math.min(fadeIn, fadeOut);
  const slideY = tpl.enter === "slide" ? interpolate(fadeIn, [0, 1], [height * 0.04, 0]) : 0;

  const lines = card.lines.length ? card.lines : [""];
  return (
    <AbsoluteFill style={{ background: bgCss, justifyContent: "center", alignItems: "center" }}>
      <div
        style={{
          display: "flex",
          flexDirection: vertical ? "row-reverse" : "column",
          gap: vertical ? fontSize * 0.5 : fontSize * 0.25,
          opacity,
          transform: `translateY(${slideY}px)`,
          maxWidth: "86%",
          maxHeight: "86%",
        }}
      >
        {lines.map((ln, i) => (
          <div
            key={i}
            style={{
              fontFamily:
                '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif',
              fontSize,
              fontWeight: ts.weight,
              color: ts.color,
              textAlign: ts.align,
              writingMode: vertical ? "vertical-rl" : "horizontal-tb",
              lineHeight: 1.25,
              letterSpacing: vertical ? "0.05em" : "0.02em",
              whiteSpace: "pre-wrap",
            }}
          >
            {ln}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

// 演出C：登場トランジション。コマ頭(frame 0..durF)だけ色フィル/ワイプを重ねる。cut/none は何も描かない＝従来。
const TransitionOverlay: React.FC<{ tr?: Shot["transition_in"] }> = ({ tr }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const kit = resolveTransitionKit(tr?.kit);
  if (kit.kind === "none") return null;
  const durF = Math.max(1, Math.round((tr?.dur_sec && tr.dur_sec > 0 ? tr.dur_sec : kit.durSec) * fps));
  if (frame >= durF) return null;
  const color = tr?.color || kit.color;
  if (kit.kind === "wipe") {
    // 色幕が左→右にワイプして退き、下のコマが出てくる。
    const r = interpolate(frame, [0, durF], [0, 100], { extrapolateRight: "clamp" });
    return <AbsoluteFill style={{ background: color, clipPath: `inset(0% ${r}% 0% 0%)` }} />;
  }
  // flash / fade / impact = 色フィルがフェードアウト（白フラッシュ＝白／黒フェード＝黒）。
  const op = interpolate(frame, [0, durF], [1, 0], { extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ background: color, opacity: op }} />;
};

const ShotView: React.FC<{ shot: Shot; st: ShotTiming; assetBase: string; metaTheme: string; isFirst?: boolean }> = ({
  shot,
  st,
  assetBase,
  metaTheme,
  isFirst,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const durF = Math.max(1, Math.round(st.durSec * fps));
  const p = interpolate(frame, [0, durF], [0, 1], { extrapolateRight: "clamp" });

  const [sx, sy, sw, sh] = shot.bbox;
  const img = shot.layers.background_inpainted
    ? `${assetBase}/${shot.layers.background_inpainted}`
    : null;

  // 演出B：背景テーマ（shot優先→meta既定→黒帯）。letterbox_black=#000=従来どおり。
  const bgTheme = resolveBgTheme(shot.background?.theme || metaTheme);
  const ov = shot.background?.override_colors ?? [];
  const bgCss = bgFillToCss(ov.length ? { ...bgTheme.fill, colors: ov } : bgTheme.fill);

  // コマの見せ方(framing)を解決（額装の判定より先に決める）
  let framing = shot.framing ?? "auto";
  if (framing === "auto") {
    // 全体表示(fit)を既定にする＝コマ端の吹き出しを切らない（色背景＋額装に浮かせる「番組」体裁）。
    // fill(ズームで画面いっぱい)はコマ横のセリフを見切るので auto では使わない（手動指定時のみ）。
    framing = "fit";
  }
  const isPan = framing === "pan";

  // 演出B：額装スタイル。全0/false=従来どおり（コマが画面いっぱい・枠なし・クリップなし）。
  // ※ pan(端から端へ流す)は額装と相性が悪い（枠でクリップすると流せない）→ pan のときは額装を無効化し
  //   画面全体で従来どおりパンする（色背景は出す）。
  const ps = shot.panel_style ?? { inset_pct: 0, radius: 0, rotation_deg: 0, shadow: false, border_color: "#ffffff", border_px: 0 };
  const framed = !isPan && (ps.inset_pct > 0 || ps.radius > 0 || ps.rotation_deg !== 0 || ps.shadow || ps.border_px > 0);
  const insetFrac = isPan ? 0 : Math.max(0, Math.min(0.45, ps.inset_pct / 100));
  // 額装の余白ぶんコマを内側に収める（inset=0なら画面全体＝従来と同値）。
  const availW = width * (1 - 2 * insetFrac);
  const availH = height * (1 - 2 * insetFrac);

  const containScale = Math.min(availW / sw, availH / sh);
  const coverScale = Math.max(availW / sw, availH / sh);
  const baseScale = framing === "fit" ? containScale : coverScale;
  const dispW = sw * baseScale;
  const dispH = sh * baseScale;

  const cam = shot.camera?.type ?? "static";
  let tScale = 1;
  let tx = 0;
  let ty = 0;
  if (framing === "pan") {
    // はみ出した分を端から端へパンして全体を見せる
    const overflowX = Math.max(0, dispW - availW);
    const overflowY = Math.max(0, dispH - availH);
    if (overflowX >= overflowY) tx = interpolate(p, [0, 1], [overflowX / 2, -overflowX / 2]);
    else ty = interpolate(p, [0, 1], [overflowY / 2, -overflowY / 2]);
  } else if (cam === "zoom_in") tScale = interpolate(p, [0, 1], [1.0, 1.12]);
  else if (cam === "static") tScale = interpolate(p, [0, 1], [1.0, 1.03]);
  else if (cam === "pan") {
    tScale = 1.08;
    tx = interpolate(p, [0, 1], [dispW * 0.04, -dispW * 0.04]);
  } else if (cam === "shake") {
    tScale = 1.06;
    tx = Math.sin(frame * 0.9) * width * 0.006;
    ty = Math.cos(frame * 1.13) * width * 0.006;
  }
  // 演出C：impact トランジションはコマ頭に軽い寄り（パンチイン）も足す。先頭コマは付けない。
  const trKit = resolveTransitionKit(shot.transition_in?.kit);
  if (!isFirst && trKit.kind === "impact") {
    const dt = (shot.transition_in?.dur_sec || trKit.durSec) * fps;
    tScale *= interpolate(frame, [0, Math.max(1, Math.round(dt))], [1.06, 1.0], { extrapolateRight: "clamp" });
  }

  // 喋り区間（reveal の張る範囲）
  const mouth = shot.mouth;
  const tSec = frame / fps;
  let speaking = false;
  let speakStart = 0;
  if (st.reveals.length > 0) {
    speakStart = Math.min(...st.reveals.map((r) => r.startSec));
    const speakEnd = Math.max(...st.reveals.map((r) => r.endSec));
    speaking = tSec >= speakStart && tSec <= speakEnd;
  }
  // 口パク=下地(原画実寸)はそのまま・口だけ重ねる方式。1コマずつ検証して詰める。
  const FLAP_ENABLED = true;
  const BOB_ENABLED = false;
  // disabled=人が「このコマは口パクしない」にした手動補正（素材は残すが静止）。
  const hasFlap = FLAP_ENABLED && !mouth?.disabled && !!(mouth?.closed_img && mouth?.open_img);
  // 音量エンベロープ(levels: 0=閉/1=半/2=開)で口の開きを駆動。音の大小に追従＝より自然。
  // 出だし(LEAD秒)は必ず閉じる。levels が無い古いデータは発声区間(voiced)の有無で開/閉にフォールバック。
  const LEAD = 0.2;
  const levels = mouth?.levels ?? [];
  const levelStep = mouth?.level_step || 0.06;
  let mouthLevel = 0;
  if (hasFlap && tSec > LEAD) {
    if (levels.length > 0) {
      const idx = Math.min(levels.length - 1, Math.max(0, Math.floor(tSec / levelStep)));
      mouthLevel = levels[idx] ?? 0;
    } else {
      const voiced = mouth?.voiced ?? [];
      mouthLevel = voiced.some((iv) => tSec >= iv[0] && tSec <= iv[1]) ? 2 : 0;
    }
  }
  // 画像選択：開(2)→open / 半(1)→half(無ければopen) / 閉(0)→closed
  const mouthSrc =
    mouthLevel >= 2
      ? mouth?.open_img
      : mouthLevel >= 1
      ? mouth?.half_img ?? mouth?.open_img
      : mouth?.closed_img;
  // 口が「見えない」コマの喋り → 体の微動(脈動)。口は見えるが動かさない静止コマ(mouthあり/open_imgなし)は脈動しない。
  const bobY =
    FLAP_ENABLED && speaking && !hasFlap && !mouth
      ? Math.sin((tSec - speakStart) * Math.PI * 2 * 1.6) * height * 0.006
      : 0;

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", overflow: "hidden" }}>
      {/* 演出B：黒帯やめてコマを気分の色背景に額装。letterbox_black は #000 で従来と同一。 */}
      <AbsoluteFill style={{ background: bgCss }} />
      {/* frame=額装の枠(回転/角丸/影/枠線/クリップ)。framed でないときは従来どおり素通し。 */}
      <div
        style={{
          width: dispW,
          height: dispH,
          position: "relative",
          transformOrigin: "center center",
          boxSizing: "border-box", // 枠線ぶんで dispW×dispH を超えない（content-box回避）
          overflow: framed ? "hidden" : "visible",
          borderRadius: framed ? ps.radius : 0,
          boxShadow: ps.shadow ? "0 14px 44px rgba(0,0,0,0.45)" : undefined,
          border: ps.border_px > 0 ? `${ps.border_px}px solid ${ps.border_color || "#ffffff"}` : undefined,
          transform: ps.rotation_deg ? `rotate(${ps.rotation_deg}deg)` : undefined,
        }}
      >
        {/* cameraWrap=カメラ移動(ズーム/パン/シェイク)。額装の枠とは分離して影/枠がズームで太らないように。 */}
        <div
          style={{
            width: "100%",
            height: "100%",
            position: "relative",
            transform: `translate(${tx}px, ${ty + bobY}px) scale(${tScale})`,
            transformOrigin: "center center",
          }}
        >
        {img && (
          <Img src={img} style={{ width: "100%", height: "100%", objectFit: "fill" }} />
        )}
        {st.reveals.map((r, k) => {
          if (!r.revealImg || !r.revealBox) return null;
          const [rx, ry, rw, rh] = r.revealBox;
          const left = ((rx - sx) / sw) * 100;
          const top = ((ry - sy) / sh) * 100;
          const w = (rw / sw) * 100;
          const h = (rh / sh) * 100;
          // セリフは「喋りに同期」して右→左に書き出す（縦書きは右の列から読むため）。
          // 声(r.startSec)に合わせて出る＝喋りと一致。範囲は erase_box（消した正範囲）なので切れない。
          const startF = Math.round(r.startSec * fps);
          const wipeFrames = Math.max(6, Math.round(r.voiceDur * fps * 0.95));
          const op = interpolate(frame, [startF, startF + 3], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const leftInset = interpolate(frame, [startF, startF + wipeFrames], [100, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <div
              key={k}
              style={{
                position: "absolute",
                left: `${left}%`,
                top: `${top}%`,
                width: `${w}%`,
                height: `${h}%`,
                opacity: op,
                clipPath: `inset(0% 0% 0% ${leftInset}%)`,
              }}
            >
              {/* 原画の文字部分をそのまま重ねて、喋りに合わせて右→左に出す（移動のみ＝フィデリティ保持） */}
              <Img
                src={`${assetBase}/${r.revealImg}`}
                style={{ width: "100%", height: "100%", objectFit: "fill" }}
              />
            </div>
          );
        })}
        {/* 口パク：顔領域(region)に「閉じ／半開き／開き」を常時重ね、音量レベルで切替。
            顔の他は原画のまま＝口だけ動く・四角も出ない（羽化済）。 */}
        {hasFlap && mouth && (() => {
          // closed_img/open_img は顔領域(region)サイズの合成画像なので region に重ねる
          const fb = mouth.region;
          return (
            <div
              style={{
                position: "absolute",
                left: `${((fb[0] - sx) / sw) * 100}%`,
                top: `${((fb[1] - sy) / sh) * 100}%`,
                width: `${(fb[2] / sw) * 100}%`,
                height: `${(fb[3] / sh) * 100}%`,
              }}
            >
              <Img
                src={`${assetBase}/${mouthSrc ?? mouth.closed_img}`}
                style={{ width: "100%", height: "100%", objectFit: "fill" }}
              />
            </div>
          );
        })()}
        </div>
      </div>

      {/* 演出C：登場トランジション（コマ頭に色フィル/ワイプを1枚重ねる。cut=何もしない＝従来）
          先頭コマだけは付けない＝動画は中身からカットインで始まる（先頭フレームが黒/白にならない）。 */}
      {!isFirst && <TransitionOverlay tr={shot.transition_in} />}

      {st.reveals.map((r, k) =>
        r.clip ? (
          <Sequence key={`a${k}`} from={Math.round(r.startSec * fps)}>
            <Audio src={`${assetBase}/${r.clip}`} />
          </Sequence>
        ) : null
      )}
      {st.sfx.map((sx, k) => (
        <Sequence key={`sx${k}`} from={Math.round(sx.startSec * fps)}>
          <Audio src={`${assetBase}/${sx.clip}`} volume={0.8} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
