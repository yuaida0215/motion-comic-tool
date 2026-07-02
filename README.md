# モーションコミック自動生成ツール

漫画1ページ（完成統合画像）を入力すると、動くサンプル動画(mp4)を出力する**編集ツール**。
作画・シナリオは作家が担い、本ツールは「バラす・喋らす・段取りする」までを自動化する。

> MVPゴール：処理ゲート **G0 → G4** を一気通貫で実装し、**統合画像1枚から mp4 が出力される**状態にする（最小BGM一発を含む）。

## 絶対に守る原則（仕様書の最重要事項）

1. **フィデリティロック**：原作画のピクセルを再生成しない。キャラの線・顔をAIで作り直さない。動かすのは「既存ピクセルの移動・合成・背景inpaint・エフェクト・合成音声」のみ。
2. **口は動かさない**：リップシンクも口元代替演出も実装しない。喋りは「吹き出しの順次出現 × TTS実尺同期 ＋ 音声」で表現。人物レイヤーは原則静止。
3. **処理単位は shot（コマ×グレード）**。ページ単位にしない。
4. **JSON駆動**：1プロジェクト＝1JSON。各ゲートが書き足し、途中保存・再開できる。
5. **G3（音声）はG4（モーション）より前**。セリフ実尺が出てから尺・文字出現を確定する。

## 処理ゲート（MVP = G0–G4）

| ゲート | 役割 | 使用技術（予定） |
|---|---|---|
| G0 取り込み・解析 | コマ分割・吹き出し検出・領域分類 | CV＋検出モデル |
| G1 演出設計 | 尺・カメラ・ビート・グレード生成 → **人が承認** | Claude API (vision) |
| G2 素材分解 | レイヤー分離・文字消し・背景inpaint | fal.ai (inpaint) |
| G3 音声 | 話者割当・TTS生成・**実尺計測** | fal.ai 経由 ElevenLabs |
| G4 モーション・DEMO | カメラ/背景モーション・文字順次出現・最小BGM → mp4 | Remotion |

## スプリント計画

| | 内容 | 完了時の状態 |
|---|---|---|
| **S0** | 雛形＋スキーマ | ✅ 完了（このコミット） |
| **S1** | G0 ＋ G1 | コマ分割・吹き出し検出・コンテJSON（人が承認） |
| **S2** | G2 | バラした素材が出る |
| **S3** | G3 | TTS音声＋セリフ実尺が出る |
| **S4** | G4 | モーション＋文字出現＋最小BGM → mp4 出力 |

各スプリント完了時に一度止めて、動作を確認してから次へ進む。

## いまの中身（S0時点）

```
motion-comic-tool/
├─ app/
│  ├─ layout.tsx          ルートレイアウト
│  ├─ page.tsx            概要＋スキーマ動作確認ページ（空JSONを表示）
│  ├─ globals.css
│  └─ api/health/route.ts 疎通確認 /api/health
├─ lib/
│  └─ schema.ts           ★プロジェクトJSONスキーマ（仕様書§6 をコード化）
├─ scripts/
│  └─ schema-check.ts     スキーマ自己テスト（npm run schema:check）
├─ package.json / tsconfig.json / next.config.mjs / vercel.json
└─ .env.example           環境変数サンプル
```

依存は **Next.js 14 / React 18 / TypeScript / Zod** のみ（雛形に必要な最小構成）。
Claude SDK・fal.ai・Remotion 等は各スプリント着手時に追加する。

## 起動方法

```bash
cd motion-comic-tool
npm install
npm run dev        # http://localhost:3000
npm run schema:check   # スキーマの自己テスト（ブラウザ不要）
```

## 環境変数

`.env.example` を `.env.local` にコピーして必要な値を埋める（雛形は空でも起動可）。
- `ANTHROPIC_API_KEY`（G1）
- `FAL_KEY`（G2 inpaint / G3 TTS）
- ストレージ系（方式未確定 → 下記）

## 未確定・要確認（着手前に合田さん判断 / 仕様書§12 ＋ 実装上の論点）

暫定デフォルトを `lib/schema.ts` に仮置き済み（後で差し替え可）。
1. **グレード方針の初期値** → 暫定 `auto`（自動仕分け）。
2. **TTS話者の当て方** → 暫定で `male_a/female_a/narration` のダミーvoice対応表。
3. **BGMプリセット** → 暫定 1曲固定 `bgm_preset_tension_01.mp3`。
4. **ストレージ方式** → ✅ **Supabase に決定**（既存 video-creative-tool と同方式）。
   JSON・画像・音声・mp4 を Supabase Storage に保存。S1着手時にプロジェクト作成手順を案内します。
