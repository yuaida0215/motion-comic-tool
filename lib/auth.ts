// 共有パスワード方式のアクセス制限。
// Cookie には AUTH_SECRET で署名したトークン `<iat>.<sig>` を入れる。
// sig = HMAC-SHA256(AUTH_SECRET, "<VERSION>:<iat>")。secret を知らない限り偽造不可。
// iat（発行時刻）を署名対象に含めるのでサーバー側で有効期限を検証でき、
// AUTH_TOKEN_VERSION を変えれば全トークンを即時失効できる。
// Web Crypto のみ使用 → Edge ミドルウェアでもそのまま動く。
const ENC = new TextEncoder();
export const COOKIE = "mct_auth";
export const MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30日
const MAX_AGE_MS = MAX_AGE_SEC * 1000;

function tokenVersion(): string {
  return process.env.AUTH_TOKEN_VERSION || "1";
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", ENC.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, ENC.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// タイミング攻撃を避ける定数時間比較（長さが違えば即false）。
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ログイン成功時に発行するトークン。AUTH_SECRET 未設定なら null（=誰も通さない fail-closed）。
export async function issueToken(): Promise<string | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const iat = Date.now();
  const sig = await hmacHex(secret, `${tokenVersion()}:${iat}`);
  return `${iat}.${sig}`;
}

export async function verifyToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const secret = process.env.AUTH_SECRET;
  if (!secret) return false; // fail-closed
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const iatStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const iat = Number(iatStr);
  if (!Number.isFinite(iat)) return false;
  if (Date.now() - iat > MAX_AGE_MS) return false; // 期限切れ
  const expected = await hmacHex(secret, `${tokenVersion()}:${iatStr}`);
  return constantTimeEqual(sig, expected);
}

// 入力パスワードを APP_PASSWORD と定数時間で照合（両者をハッシュして長さ・タイミングを揃える）。
export async function passwordOk(submitted: string): Promise<boolean> {
  const pw = process.env.APP_PASSWORD;
  if (!pw || !submitted) return false;
  const a = await hmacHex("mct-pw-compare", submitted);
  const b = await hmacHex("mct-pw-compare", pw);
  return constantTimeEqual(a, b);
}

// 制御文字（タブ/改行/CR など 0x00–0x1F, 0x7F）を含むか。
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

// /login?next= のオープンリダイレクト防止。
// 制御文字を拒否し、URL解決後に同一オリジンの相対パスのみ許可。
// 別オリジン・protocol-relative・バックスラッシュ経由のものは origin チェックで弾く。
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || hasControlChar(next)) return "/";
  try {
    const u = new URL(next, "http://localhost");
    if (u.origin !== "http://localhost") return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}
