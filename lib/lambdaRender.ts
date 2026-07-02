/**
 * G4 動画書き出し（本番用）：Remotion Lambda（AWS）でレンダリングする。
 * ------------------------------------------------------------------
 * @remotion/renderer（scripts/render.mjs）はローカルでChromiumを直接起動するので
 * サーバレス(Vercel)では動かない。本番はここでAWS Lambda上のレンダーワーカーに
 * 投げ、完了をポーリングして結果のmp4を取得する（呼び出し元がSupabaseへ保存する）。
 *
 * 必要な環境変数（無ければ lambdaConfigured() が false → 呼び出し元がローカル
 * レンダー(scripts/render.mjs)にフォールバックする＝ローカル開発は今までどおり）:
 *   REMOTION_AWS_ACCESS_KEY_ID / REMOTION_AWS_SECRET_ACCESS_KEY
 *     （AWS_ACCESS_KEY_ID等ではなくこの名前にするのは、Vercelが予約している
 *      AWS_* 環境変数と衝突させないため。Remotion Lambda公式の推奨名）
 *   REMOTION_LAMBDA_REGION        例: ap-northeast-1
 *   REMOTION_LAMBDA_FUNCTION_NAME  `npx remotion lambda functions deploy` の出力
 *   REMOTION_LAMBDA_SERVE_URL      `npx remotion lambda sites create` の出力
 */
import { getRenderProgress, renderMediaOnLambda } from "@remotion/lambda-client";
import type { AwsRegion } from "@remotion/lambda-client";

export function lambdaConfigured(): boolean {
  return !!(
    process.env.REMOTION_LAMBDA_FUNCTION_NAME &&
    process.env.REMOTION_LAMBDA_SERVE_URL &&
    process.env.REMOTION_LAMBDA_REGION &&
    process.env.REMOTION_AWS_ACCESS_KEY_ID &&
    process.env.REMOTION_AWS_SECRET_ACCESS_KEY
  );
}

// Vercel関数のmaxDuration（g4/route.tsで300s設定）より確実に短く打ち切る。
const POLL_TIMEOUT_MS = 270_000;
const POLL_INTERVAL_MS = 3000;

/** Lambdaでレンダリングし、完了したmp4のバイト列を返す（呼び出し元がstorageへ保存）。 */
export async function renderOnLambda(inputProps: Record<string, unknown>): Promise<Buffer> {
  const region = process.env.REMOTION_LAMBDA_REGION as AwsRegion;
  const functionName = process.env.REMOTION_LAMBDA_FUNCTION_NAME as string;
  const serveUrl = process.env.REMOTION_LAMBDA_SERVE_URL as string;
  // AWSアカウントのLambda同時実行数クォータ（新規アカウントは既定10）を超えると
  // "Rate Exceeded" で失敗するため、上限未満に抑える。`npx remotion lambda quotas` で
  // 確認できる実際の値より小さい値をここに設定する。増枠後はこの値を上げれば速くなる。
  const concurrency = Number(process.env.REMOTION_LAMBDA_CONCURRENCY || 8);

  const { renderId, bucketName } = await renderMediaOnLambda({
    region,
    functionName,
    serveUrl,
    composition: "MotionComic",
    inputProps,
    codec: "h264",
    concurrency,
  });

  const start = Date.now();
  for (;;) {
    const progress = await getRenderProgress({ renderId, bucketName, functionName, region });

    if (progress.fatalErrorEncountered) {
      const msg = progress.errors.map((e) => e.message).join("; ").slice(0, 400);
      throw new Error(`Lambdaレンダー失敗: ${msg || "不明なエラー"}`);
    }
    if (progress.done) {
      if (!progress.outputFile) throw new Error("Lambdaレンダー完了だが出力URLが無い");
      const res = await fetch(progress.outputFile);
      if (!res.ok) throw new Error(`Lambda出力の取得に失敗 (HTTP ${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    }
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      throw new Error(
        `Lambdaレンダーが${Math.round(POLL_TIMEOUT_MS / 1000)}秒でタイムアウトしました（renderId=${renderId}）。コマ数/尺を減らすか、時間をおいて再実行してください。`
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
