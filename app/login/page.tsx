import { safeNext } from "@/lib/auth";

export const metadata = { title: "ログイン｜モーションコミック自動生成ツール" };

// 共有パスワードのログイン画面（サーバーコンポーネント・素のフォーム）。
export default function LoginPage({ searchParams }: { searchParams: { e?: string; next?: string } }) {
  const next = safeNext(searchParams.next);
  const action = "/api/auth/login" + (next !== "/" ? "?next=" + encodeURIComponent(next) : "");
  const err =
    searchParams.e === "config"
      ? "サーバー設定が未完了です。管理者に連絡してください。"
      : searchParams.e
      ? "パスワードが違います。"
      : null;

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <form
        method="post"
        action={action}
        style={{
          width: "100%",
          maxWidth: 360,
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 28,
        }}
      >
        <h1 style={{ fontSize: 20, margin: "0 0 6px" }}>ログイン</h1>
        <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 16px" }}>
          このツールは関係者限定です。共有パスワードを入力してください。
        </p>
        {err && (
          <div
            style={{
              color: "#ff8080",
              fontSize: 13,
              marginBottom: 12,
              padding: "8px 10px",
              background: "rgba(255,80,80,0.08)",
              border: "1px solid rgba(255,80,80,0.25)",
              borderRadius: 6,
            }}
          >
            {err}
          </div>
        )}
        <div style={{ marginBottom: 16 }}>
          <label htmlFor="password" style={{ display: "block", fontSize: 13, color: "var(--muted)", marginBottom: 6 }}>
            パスワード
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoFocus
            autoComplete="current-password"
            required
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--panel-2)",
              color: "var(--text)",
              fontSize: 14,
            }}
          />
        </div>
        <button
          type="submit"
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 6,
            border: "none",
            background: "var(--accent)",
            color: "#0f1115",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          ログイン
        </button>
      </form>
    </main>
  );
}
