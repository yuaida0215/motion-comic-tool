"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function NewProjectForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fileNames, setFileNames] = useState<string[]>([]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    const form = e.currentTarget;
    const data = new FormData(form);
    const picked = (data.getAll("files") as unknown[]).filter(
      (f): f is File => f instanceof File && f.size > 0
    );
    if (picked.length === 0) {
      setErr("画像ファイルを選んでください（複数ページ可）");
      return;
    }
    // 既定はファイル名順（数値順）。複数ページの並びはこれを基準にする。
    picked.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    data.delete("files");
    for (const f of picked) data.append("files", f);
    setBusy(true);
    try {
      const res = await fetch("/api/projects", { method: "POST", body: data });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "作成に失敗しました");
      router.push(`/projects/${json.project_id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 14 }}>
      <label style={label}>
        <span style={labelText}>マンガ画像（PNG / JPEG / WebP）― 複数ページ選択OK（章まるごと）</span>
        <input
          type="file"
          name="files"
          accept="image/png,image/jpeg,image/webp"
          multiple
          required
          onChange={(e) =>
            setFileNames(
              Array.from(e.target.files ?? [])
                .map((f) => f.name)
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            )
          }
          style={{ color: "var(--text)" }}
        />
        {fileNames.length > 0 && (
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            選択 {fileNames.length}枚（ファイル名順）: {fileNames.join(" / ")}
          </span>
        )}
      </label>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <label style={label}>
          <span style={labelText}>タイトル</span>
          <input type="text" name="title" placeholder="例: 第1話 p.12" style={input} />
        </label>
        <label style={label}>
          <span style={labelText}>画角</span>
          <select name="delivery" defaultValue="vertical" style={input}>
            <option value="vertical">9:16（縦）</option>
            <option value="square">1:1（正方形）</option>
            <option value="horizontal">16:9（横）</option>
          </select>
        </label>
      </div>

      {err && <div style={{ color: "#ff8080", fontSize: 13 }}>{err}</div>}

      <div>
        <button type="submit" disabled={busy} style={primaryBtn(busy)}>
          {busy ? "作成中…" : "プロジェクトを作成"}
        </button>
      </div>
    </form>
  );
}

const label: React.CSSProperties = { display: "grid", gap: 6 };
const labelText: React.CSSProperties = { fontSize: 13, color: "var(--muted)" };
const input: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  padding: "8px 10px",
  fontSize: 14,
};
function primaryBtn(busy: boolean): React.CSSProperties {
  return {
    background: busy ? "#3a4a6a" : "var(--accent)",
    color: "#0b0e14",
    border: "none",
    borderRadius: 6,
    padding: "10px 18px",
    fontSize: 14,
    fontWeight: 700,
    cursor: busy ? "default" : "pointer",
  };
}
