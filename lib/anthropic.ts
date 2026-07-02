/**
 * Claude API ラッパ（G0 検出・OCR / G1 コンテ生成で使う）。
 * ------------------------------------------------------------------
 *  - 画像 ＋ 指示 を渡し、構造化JSON(スキーマ準拠)を受け取るヘルパ。
 *  - 構造化出力は output_config.format（json_schema）を使用。サーバ側でスキーマ準拠を保証。
 *  - 思考は adaptive（モデルが必要に応じて推論）。
 *  - トークン使用量からAPIコストを概算し cost_log 用に返す。
 */
import Anthropic from "@anthropic-ai/sdk";

/** ゲート別の使用モデル。MVPは精度優先で両方 Opus 4.8。
 *  量産時のコスト削減で G0 を Sonnet 4.6 に下げるのは容易（ここを変えるだけ）。 */
export const GATE_MODELS = {
  G0: "claude-opus-4-8",
  G1: "claude-opus-4-8",
  G3: "claude-opus-4-8", // 話者割当(vision)
} as const;

/** 100万トークンあたりの料金(USD)。cost_log の概算用。 */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** トークン使用量からコスト(USD)を概算。cache read=0.1x / write=1.25x で見積り。 */
export function estimateCostUsd(model: string, usage: Usage): number {
  const p = PRICING[model];
  if (!p) return 0;
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cost =
    (inTok * p.input +
      cacheRead * p.input * 0.1 +
      cacheWrite * p.input * 1.25 +
      outTok * p.output) /
    1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

let _client: Anthropic | null = null;
export function getAnthropic(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY が未設定です（.env.local を確認）");
  _client = new Anthropic({ apiKey });
  return _client;
}

export type ImageInput = {
  /** base64文字列（dataURLプレフィックス無し）。 */
  data: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
};

/**
 * 画像＋指示を渡して、JSONスキーマ準拠の構造化JSONを得る。
 * 返り値の data は JSON.parse 済みの unknown（呼び出し側で型キャスト）。
 * 使用量・コスト概算も返す（cost_log 用）。
 */
export async function visionJson(opts: {
  model: string;
  system: string;
  prompt: string;
  image: ImageInput;
  jsonSchema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<{ data: unknown; usage: Usage; costUsd: number }> {
  const client = getAnthropic();
  const res = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 16000,
    thinking: { type: "adaptive" },
    system: opts.system,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: opts.image.mediaType,
              data: opts.image.data,
            },
          },
          { type: "text", text: opts.prompt },
        ],
      },
    ],
    output_config: { format: { type: "json_schema", schema: opts.jsonSchema } },
  });

  if (res.stop_reason === "refusal") {
    throw new Error("リクエストが拒否されました（refusal）");
  }
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text.trim()) {
    throw new Error("空の応答（構造化出力が得られませんでした）");
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("構造化出力のJSON解析に失敗しました");
  }
  const usage = res.usage as Usage;
  return { data, usage, costUsd: estimateCostUsd(opts.model, usage) };
}
