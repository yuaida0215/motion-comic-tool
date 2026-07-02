import { NextResponse } from "next/server";
import { createProject, listProjects, saveProject } from "@/lib/projects";
import { getStorage } from "@/lib/storage";
import {
  DeliverySchema,
  GradePolicySchema,
  type Delivery,
  type GradePolicy,
} from "@/lib/schema";

export const runtime = "nodejs";
// GETをNext.jsの静的キャッシュ対象にしない（毎回ストレージの最新状態を返す）。
// これが無いと「保存はできているのに、画面には古い状態が返り続ける」事故になる。
export const dynamic = "force-dynamic";

// 一覧
export async function GET() {
  const projects = await listProjects();
  return NextResponse.json({ projects });
}

// 新規作成（画像アップロード）。1枚＝従来どおり（source.ext）／複数枚＝多ページ（pages/page_NN）。
export async function POST(req: Request) {
  const form = await req.formData();
  // "file"（従来・単数）と "files"（複数）の両方を受ける。受信順＝ページ順（UIで並べ替え済み前提）。
  const files = [...form.getAll("files"), ...form.getAll("file")].filter(
    (f): f is File => f instanceof File && f.size > 0
  );
  if (files.length === 0) {
    return NextResponse.json({ error: "画像ファイルが必要です（空ファイル不可）" }, { status: 400 });
  }

  const title = (form.get("title") as string) || "";
  const deliveryRaw = (form.get("delivery") as string) || "vertical";
  const gradeRaw = (form.get("grade_policy") as string) || "auto";
  const durRaw = Number(form.get("target_duration_sec")) || undefined;

  const delivery: Delivery = DeliverySchema.safeParse(deliveryRaw).success
    ? (deliveryRaw as Delivery)
    : "vertical";
  const grade_policy: GradePolicy = GradePolicySchema.safeParse(gradeRaw).success
    ? (gradeRaw as GradePolicy)
    : "auto";

  const extOf = (f: File) =>
    ((f.name || "page.png").toLowerCase().split(".").pop() || "png").replace(/[^a-z0-9]/g, "");

  if (files.length === 1) {
    // 単一ページ（従来と同一の挙動：source.ext、meta.pages は空）
    const file = files[0];
    const sourceRel = `source.${extOf(file)}`;
    const project = await createProject({ source_image: sourceRel, title, delivery, target_duration_sec: durRaw, grade_policy });
    const bytes = Buffer.from(await file.arrayBuffer());
    await getStorage().putAsset(project.meta.project_id, sourceRel, bytes, file.type || "application/octet-stream");
    return NextResponse.json({ project_id: project.meta.project_id });
  }

  // 多ページ：pages/page_NN.ext に保存。source_image は pages[0]（後方互換）。
  const pages = files.map((f, i) => {
    const id = `page_${String(i + 1).padStart(2, "0")}`;
    return { id, file: f, source_image: `pages/${id}.${extOf(f)}`, index: i };
  });
  const project = await createProject({
    source_image: pages[0].source_image,
    title,
    delivery,
    target_duration_sec: durRaw,
    grade_policy,
  });
  const storage = getStorage();
  for (const p of pages) {
    const bytes = Buffer.from(await p.file.arrayBuffer());
    await storage.putAsset(project.meta.project_id, p.source_image, bytes, p.file.type || "application/octet-stream");
  }
  project.meta.pages = pages.map((p) => ({ id: p.id, source_image: p.source_image, index: p.index }));
  await saveProject(project);

  return NextResponse.json({ project_id: project.meta.project_id, pages: pages.length });
}
