/**
 * プロジェクト操作のヘルパ層。
 * UI/APIルートは原則このファイル経由でプロジェクトJSONを読み書きする
 * （ストレージの実体には直接触らない）。
 */
import {
  createEmptyProject,
  type Delivery,
  type Gate,
  type GradePolicy,
  type Project,
  type GateState,
  type CostLogEntry,
} from "./schema";
import { getStorage } from "./storage";

function nowIso() {
  return new Date().toISOString();
}

/** 短いプロジェクトIDを生成（時刻ベース＋乱数。人間が見て区別できる程度）。 */
function genProjectId() {
  const t = new Date();
  const stamp =
    t.getFullYear().toString().slice(2) +
    String(t.getMonth() + 1).padStart(2, "0") +
    String(t.getDate()).padStart(2, "0") +
    "-" +
    String(t.getHours()).padStart(2, "0") +
    String(t.getMinutes()).padStart(2, "0") +
    String(t.getSeconds()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return `p${stamp}-${rand}`;
}

/** 新規プロジェクトを作成して保存する。 */
export async function createProject(input: {
  source_image: string;
  title?: string;
  delivery?: Delivery;
  target_duration_sec?: number;
  grade_policy?: GradePolicy;
}): Promise<Project> {
  const project = createEmptyProject({
    project_id: genProjectId(),
    created_at: nowIso(),
    source_image: input.source_image,
    title: input.title,
    delivery: input.delivery,
    target_duration_sec: input.target_duration_sec,
    grade_policy: input.grade_policy,
  });
  await getStorage().saveProject(project);
  return project;
}

export async function getProject(id: string): Promise<Project | null> {
  return getStorage().loadProject(id);
}

export async function saveProject(project: Project): Promise<void> {
  return getStorage().saveProject(project);
}

export async function listProjects() {
  return getStorage().listProjects();
}

/** ゲートの進捗状態を更新する（state / approved / error）。 */
export async function setGateState(
  id: string,
  gate: Gate,
  patch: Partial<{ state: GateState; approved: boolean; error: string | null }>
): Promise<Project> {
  const project = await getProject(id);
  if (!project) throw new Error(`project not found: ${id}`);
  const g = project.pipeline[gate];
  if (patch.state !== undefined) g.state = patch.state;
  if (patch.approved !== undefined) g.approved = patch.approved;
  if (patch.error !== undefined) g.error = patch.error;
  g.updated_at = nowIso();
  await saveProject(project);
  return project;
}

/** コストログを1件追記する（処理時間・APIコスト）。 */
export async function appendCostLog(
  id: string,
  entry: Omit<CostLogEntry, "at"> & { at?: string | null }
): Promise<Project> {
  const project = await getProject(id);
  if (!project) throw new Error(`project not found: ${id}`);
  project.cost_log.push({
    gate: entry.gate,
    elapsed_sec: entry.elapsed_sec ?? 0,
    api_cost: entry.api_cost ?? 0,
    note: entry.note ?? "",
    at: entry.at ?? nowIso(),
  });
  await saveProject(project);
  return project;
}

/**
 * ゲート処理を実行しつつ、状態(running→done/error)・コストログ・プロジェクト本体の
 * 変更を「1つのプロジェクトオブジェクト」にまとめて保存するラッパ。
 * fn は渡された project を直接書き換え（shots等）、コストとメモだけ返す。
 * 各ゲート(G0–G4)の実装はこれで包む。戻り値は更新後のプロジェクト。
 */
export async function runGate(
  id: string,
  gate: Gate,
  fn: (project: Project) => Promise<{ api_cost?: number; note?: string }>
): Promise<Project> {
  const startedAt = Date.now();

  // 開始マーク
  const start = await getProject(id);
  if (!start) throw new Error(`project not found: ${id}`);
  start.pipeline[gate].state = "running";
  start.pipeline[gate].error = null;
  start.pipeline[gate].updated_at = nowIso();
  await saveProject(start);

  try {
    const project = await getProject(id);
    if (!project) throw new Error(`project not found: ${id}`);
    const { api_cost, note } = await fn(project); // project を直接書き換える
    project.cost_log.push({
      gate,
      elapsed_sec: (Date.now() - startedAt) / 1000,
      api_cost: api_cost ?? 0,
      note: note ?? "",
      at: nowIso(),
    });
    project.pipeline[gate].state = "done";
    project.pipeline[gate].updated_at = nowIso();
    await saveProject(project); // 本体＋状態＋コストを一括保存
    return project;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const p = await getProject(id);
    if (p) {
      p.pipeline[gate].state = "error";
      p.pipeline[gate].error = msg;
      p.pipeline[gate].updated_at = nowIso();
      await saveProject(p);
    }
    throw e;
  }
}
