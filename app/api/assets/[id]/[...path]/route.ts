import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
// GETをNext.jsの静的キャッシュ対象にしない（動画/画像を作り直した後、古いバイト列が
// 返り続けるのを防ぐ。cache-control:no-storeはブラウザ/CDN向けで、これとは別レイヤー）。
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  json: "application/json",
};

// ローカル開発時の生成物配信（Supabase運用時は署名URLを使う）
export async function GET(
  _req: Request,
  { params }: { params: { id: string; path: string[] } }
) {
  const rel = params.path.join("/");
  const bytes = await getStorage().getAssetBytes(params.id, rel);
  if (!bytes) return new Response("not found", { status: 404 });
  const ext = rel.toLowerCase().split(".").pop() || "";
  const contentType = TYPES[ext] || "application/octet-stream";
  return new Response(new Uint8Array(bytes), {
    headers: { "content-type": contentType, "cache-control": "no-store" },
  });
}
