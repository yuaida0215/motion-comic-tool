/**
 * ストレージ＋プロジェクト永続化層の自己テスト。`npm run storage:check` で実行。
 * ローカルFSアダプタに対して 作成→保存→再読込→更新 が往復することを確認する
 * （Claude APIも画像も不要。土台が壊れていないかを素早く確認する用途）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

// Supabase系を無効化し、ローカルFSの一時ディレクトリを使わせる
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_DIR = path.join(process.cwd(), ".storage-test");
process.env.STORAGE_DIR = TEST_DIR;

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok -", msg);
}

async function main() {
  await fs.rm(TEST_DIR, { recursive: true, force: true });

  // env設定後に動的import（getStorageが保存先を決めるため）
  const { getStorage } = await import("../lib/storage");
  const projects = await import("../lib/projects");

  assert(getStorage().kind === "local", "保存先はローカルFS（Supabase未設定時）");

  console.log("[1] 作成 → 再読込");
  const created = await projects.createProject({
    source_image: "page01.png",
    title: "テストページ",
  });
  const loaded = await projects.getProject(created.meta.project_id);
  assert(loaded !== null, "作成したプロジェクトを読み込める");
  assert(loaded!.meta.title === "テストページ", "title が往復する");

  console.log("[2] ゲート状態の更新（レビューゲート）");
  await projects.setGateState(created.meta.project_id, "G0", { state: "done" });
  await projects.setGateState(created.meta.project_id, "G1", {
    state: "done",
    approved: true,
  });
  const afterGate = await projects.getProject(created.meta.project_id);
  assert(afterGate!.pipeline.G0.state === "done", "G0 が done になる");
  assert(afterGate!.pipeline.G1.approved === true, "G1 承認フラグが保存される");

  console.log("[3] コストログ追記");
  await projects.appendCostLog(created.meta.project_id, {
    gate: "G0",
    elapsed_sec: 1.2,
    api_cost: 0.01,
    note: "test",
  });
  const afterCost = await projects.getProject(created.meta.project_id);
  assert(afterCost!.cost_log.length === 1, "コストログが1件記録される");

  console.log("[4] 生成物(アセット)の保存・取得");
  const ref = await getStorage().putAsset(
    created.meta.project_id,
    "shot01_char.png",
    Buffer.from("dummy-bytes"),
    "image/png"
  );
  const back = await getStorage().getAssetBytes(created.meta.project_id, ref);
  assert(back?.toString() === "dummy-bytes", "保存したアセットを取り出せる");

  console.log("[5] 一覧");
  const list = await projects.listProjects();
  assert(
    list.some((p) => p.project_id === created.meta.project_id),
    "listProjects に作成分が含まれる"
  );

  await fs.rm(TEST_DIR, { recursive: true, force: true });
  console.log("\n✅ storage:check 全項目パス");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
