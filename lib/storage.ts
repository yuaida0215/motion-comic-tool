/**
 * ストレージ抽象（アダプタ方式）
 * ------------------------------------------------------------------
 * プロジェクトJSONと生成物(画像/音声/mp4)の保存を、保存先によらず同じ
 * インターフェイスで扱う。
 *
 *  - 開発中: ローカルFS（./storage 配下）。Supabaseの準備を待たずに動かせる。
 *  - 本番:   Supabase Storage（環境変数が揃っていれば自動でこちらを使う）。
 *
 * これにより「Supabaseに決定」を守りつつ、開発はローカルで素早く回せる。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseProject, type Project } from "./schema";

export interface ProjectSummary {
  project_id: string;
  title: string;
  created_at: string;
}

export interface Storage {
  /** ストレージ種別（ログ/UI表示用）。 */
  readonly kind: "local" | "supabase";
  saveProject(project: Project): Promise<void>;
  loadProject(projectId: string): Promise<Project | null>;
  listProjects(): Promise<ProjectSummary[]>;
  /** 生成物を保存し、参照キー(相対パス)を返す。 */
  putAsset(
    projectId: string,
    relPath: string,
    data: Buffer,
    contentType: string
  ): Promise<string>;
  getAssetBytes(projectId: string, relPath: string): Promise<Buffer | null>;
  /** UI/Remotionから取得するためのURL（local: APIルート / supabase: 署名URL）。 */
  getAssetUrl(projectId: string, relPath: string): Promise<string>;
}

/* ===================== ローカルFSアダプタ ===================== */

class LocalStorage implements Storage {
  readonly kind = "local" as const;
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  private projectDir(id: string) {
    return path.join(this.root, id);
  }
  private projectJsonPath(id: string) {
    return path.join(this.projectDir(id), "project.json");
  }
  private assetPath(id: string, relPath: string) {
    return path.join(this.projectDir(id), "assets", relPath);
  }

  async saveProject(project: Project): Promise<void> {
    const dir = this.projectDir(project.meta.project_id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      this.projectJsonPath(project.meta.project_id),
      JSON.stringify(project, null, 2),
      "utf8"
    );
  }

  async loadProject(projectId: string): Promise<Project | null> {
    try {
      const raw = await fs.readFile(this.projectJsonPath(projectId), "utf8");
      return parseProject(JSON.parse(raw));
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw e;
    }
  }

  async listProjects(): Promise<ProjectSummary[]> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.root);
    } catch {
      return [];
    }
    const out: ProjectSummary[] = [];
    for (const id of entries) {
      const p = await this.loadProject(id);
      if (p) {
        out.push({
          project_id: p.meta.project_id,
          title: p.meta.title,
          created_at: p.meta.created_at,
        });
      }
    }
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async putAsset(
    projectId: string,
    relPath: string,
    data: Buffer
  ): Promise<string> {
    const dest = this.assetPath(projectId, relPath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, data);
    return relPath;
  }

  async getAssetBytes(projectId: string, relPath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.assetPath(projectId, relPath));
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw e;
    }
  }

  async getAssetUrl(projectId: string, relPath: string): Promise<string> {
    // ローカルではAPIルート経由で配信する（/api/assets/[...]）。
    return `/api/assets/${encodeURIComponent(projectId)}/${relPath}`;
  }
}

/* ===================== Supabaseアダプタ ===================== */

const BUCKET = "motion-comic";

class SupabaseStorage implements Storage {
  readonly kind = "supabase" as const;
  private client: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.client = createClient(url, serviceKey, {
      auth: { persistSession: false },
      // Next.js(Vercel)はグローバルfetchをパッチしてData Cacheの対象にする。
      // Supabase SDKの素のfetchがそれに巻き込まれ、G0等で保存した直後のGETが
      // 「保存できているのに古い状態が返り続ける」事故になった（route側のforce-dynamic
      // だけでは内部fetchのキャッシュまでは外れなかった）。ここで明示的にno-storeを強制する。
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, cache: "no-store" }),
      },
    });
  }

  private projectKey(id: string) {
    return `${id}/project.json`;
  }
  private assetKey(id: string, relPath: string) {
    return `${id}/assets/${relPath}`;
  }

  async saveProject(project: Project): Promise<void> {
    const body = Buffer.from(JSON.stringify(project, null, 2), "utf8");
    const { error } = await this.client.storage
      .from(BUCKET)
      .upload(this.projectKey(project.meta.project_id), body, {
        contentType: "application/json",
        upsert: true,
      });
    if (error) throw error;
  }

  async loadProject(projectId: string): Promise<Project | null> {
    const { data, error } = await this.client.storage
      .from(BUCKET)
      .download(this.projectKey(projectId));
    if (error || !data) return null;
    const raw = await data.text();
    return parseProject(JSON.parse(raw));
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const { data, error } = await this.client.storage.from(BUCKET).list("", {
      limit: 1000,
    });
    if (error || !data) return [];
    const out: ProjectSummary[] = [];
    for (const entry of data) {
      if (!entry.name) continue;
      const p = await this.loadProject(entry.name);
      if (p) {
        out.push({
          project_id: p.meta.project_id,
          title: p.meta.title,
          created_at: p.meta.created_at,
        });
      }
    }
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async putAsset(
    projectId: string,
    relPath: string,
    data: Buffer,
    contentType: string
  ): Promise<string> {
    const { error } = await this.client.storage
      .from(BUCKET)
      .upload(this.assetKey(projectId, relPath), data, {
        contentType,
        upsert: true,
      });
    if (error) throw error;
    return relPath;
  }

  async getAssetBytes(projectId: string, relPath: string): Promise<Buffer | null> {
    const { data, error } = await this.client.storage
      .from(BUCKET)
      .download(this.assetKey(projectId, relPath));
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  }

  async getAssetUrl(projectId: string, relPath: string): Promise<string> {
    const { data } = await this.client.storage
      .from(BUCKET)
      .createSignedUrl(this.assetKey(projectId, relPath), 60 * 60);
    return data?.signedUrl ?? "";
  }
}

/* ===================== 選択ロジック ===================== */

let _storage: Storage | null = null;

/**
 * 環境に応じたストレージを返す（シングルトン）。
 * SUPABASE系の環境変数が揃っていれば Supabase、無ければローカルFS。
 */
export function getStorage(): Storage {
  if (_storage) return _storage;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (url && serviceKey) {
    _storage = new SupabaseStorage(url, serviceKey);
  } else {
    const root = process.env.STORAGE_DIR || path.join(process.cwd(), "storage");
    _storage = new LocalStorage(root);
  }
  return _storage;
}
