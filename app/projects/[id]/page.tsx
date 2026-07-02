import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/lib/projects";
import { getStorage } from "@/lib/storage";
import ReviewClient from "./ReviewClient";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: { id: string };
}) {
  const project = await getProject(params.id);
  if (!project) notFound();

  const assetUrl = await getStorage().getAssetUrl(
    params.id,
    project.meta.source_image
  );

  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: "28px 24px 96px" }}>
      <Link href="/" style={{ fontSize: 13, color: "var(--accent)" }}>
        ← 一覧へ
      </Link>
      <ReviewClient initialProject={project} assetUrl={assetUrl} />
    </main>
  );
}
