/**
 * fal.ai 呼び出しラッパ（G2 文字消し・inpaint で使用）。
 * queue.fal.run に投入 → ポーリング → 結果取得、の定番フロー。
 * 認証は Authorization: Key <FAL_KEY>。
 */
const QUEUE = "https://queue.fal.run";

function authHeaders(): Record<string, string> {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY が未設定です（.env.local を確認）");
  return { Authorization: `Key ${key}`, "Content-Type": "application/json" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fal モデルを実行し、完了後の結果JSONを返す。 */
export async function falRun(
  modelId: string,
  input: Record<string, unknown>,
  opts: { timeoutMs?: number } = {}
): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? 180_000;

  const submit = await fetch(`${QUEUE}/${modelId}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(input),
  });
  if (!submit.ok) {
    throw new Error(`fal投入失敗 (${submit.status}): ${(await submit.text()).slice(0, 300)}`);
  }
  const job = (await submit.json()) as {
    status_url?: string;
    response_url?: string;
    request_id?: string;
  };
  const statusUrl =
    job.status_url || `${QUEUE}/${modelId}/requests/${job.request_id}/status`;
  const responseUrl =
    job.response_url || `${QUEUE}/${modelId}/requests/${job.request_id}`;

  const start = Date.now();
  for (;;) {
    await sleep(2000);
    const st = await fetch(statusUrl, { headers: authHeaders() });
    const s = (await st.json()) as { status?: string; error?: unknown };
    if (s.status === "COMPLETED") break;
    if (s.status === "FAILED" || s.error) {
      throw new Error("fal処理失敗: " + JSON.stringify(s).slice(0, 300));
    }
    if (Date.now() - start > timeoutMs) throw new Error("falタイムアウト");
  }

  const res = await fetch(responseUrl, { headers: authHeaders() });
  if (!res.ok) throw new Error(`fal結果取得失敗 (${res.status})`);
  return (await res.json()) as Record<string, unknown>;
}

/** fal結果JSONから画像URLを取り出す（image / images[0] の両対応）。 */
export function pickImageUrl(result: Record<string, unknown>): string | null {
  const img = result.image as { url?: string } | undefined;
  if (img?.url) return img.url;
  const imgs = result.images as Array<{ url?: string }> | undefined;
  if (imgs && imgs[0]?.url) return imgs[0].url;
  return null;
}

/** URLから画像バイトを取得。 */
export async function fetchImageBytes(url: string): Promise<Buffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`画像ダウンロード失敗 (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}
