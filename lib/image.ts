/**
 * 入力画像（統合原稿）の読み込みヘルパ。
 * ストレージから元画像のバイトを取り、base64・MIME・寸法を返す。
 * フィデリティロック: 元画像はここで読むだけ。再生成は一切しない。
 */
import sharp from "sharp";
import { getStorage } from "./storage";
import type { ImageInput } from "./anthropic";
import type { Project } from "./schema";

export type LoadedImage = {
  data: string;
  mediaType: ImageInput["mediaType"];
  width: number;
  height: number;
  bytes: Buffer;
};

function mediaTypeFromPath(p: string): ImageInput["mediaType"] {
  const ext = p.toLowerCase().split(".").pop();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

async function loadFromPath(projectId: string, path: string): Promise<LoadedImage> {
  const bytes = await getStorage().getAssetBytes(projectId, path);
  if (!bytes) {
    throw new Error(`元画像が見つかりません: ${path}`);
  }
  const meta = await sharp(bytes).metadata();
  return {
    data: bytes.toString("base64"),
    mediaType: mediaTypeFromPath(path),
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    bytes,
  };
}

export async function loadSourceImage(project: Project): Promise<LoadedImage> {
  return loadFromPath(project.meta.project_id, project.meta.source_image);
}

/**
 * 多ページ（v3）：コマが属するページ画像を読む。
 * pageId が空 or 見つからない／pages が空＝単一ページ → meta.source_image にフォールバック（後方互換）。
 */
export async function loadPageImage(project: Project, pageId: string): Promise<LoadedImage> {
  const pages = project.meta.pages ?? [];
  const page = pageId ? pages.find((p) => p.id === pageId) : undefined;
  const src = page?.source_image || pages[0]?.source_image || project.meta.source_image;
  return loadFromPath(project.meta.project_id, src);
}
