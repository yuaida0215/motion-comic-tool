import Link from "next/link";
import { listProjects } from "@/lib/projects";
import { SCHEMA_VERSION } from "@/lib/schema";
import NewProjectForm from "./_components/NewProjectForm";

export const dynamic = "force-dynamic";

export default async function Home() {
  const projects = await listProjects();

  return (
    <main style={{ maxWidth: 880, margin: "0 auto", padding: "48px 24px 96px" }}>
      <header style={{ marginBottom: 8 }}>
        <div style={{ color: "var(--muted)", fontSize: 13, letterSpacing: 1 }}>
          MVP / G0–G4 ・ schema v{SCHEMA_VERSION}
        </div>
        <h1 style={{ fontSize: 28, margin: "6px 0 4px" }}>
          モーションコミック自動生成ツール
        </h1>
        <p style={{ color: "var(--muted)", margin: 0 }}>
          マンガ1ページ（統合画像）をアップロード → コマ検出・OCR・コンテ生成 →
          承認 →（この先のスプリントで）動画化。
        </p>
      </header>

      <section style={{ marginTop: 28 }}>
        <h2 style={sectionH}>新規プロジェクト（画像アップロード）</h2>
        <NewProjectForm />
      </section>

      <section style={{ marginTop: 36 }}>
        <h2 style={sectionH}>プロジェクト一覧</h2>
        {projects.length === 0 ? (
          <p style={{ color: "var(--muted)" }}>
            まだありません。上で画像をアップロードして作成してください。
          </p>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {projects.map((p) => (
              <Link
                key={p.project_id}
                href={`/projects/${p.project_id}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "12px 14px",
                  background: "var(--panel-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  textDecoration: "none",
                  color: "var(--text)",
                }}
              >
                <span style={{ fontWeight: 600 }}>{p.title || "(無題)"}</span>
                <span style={{ color: "var(--muted)", fontSize: 13 }}>
                  {p.project_id}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

const sectionH: React.CSSProperties = {
  fontSize: 16,
  margin: "0 0 12px",
  paddingBottom: 8,
  borderBottom: "1px solid var(--border)",
};
