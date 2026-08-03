import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCustomerProjectSurfaceModel } from "./customer_project_surface_model.mjs";
import { assertSafeMeetingArtifact } from "./customer_project_meeting.mjs";
import {
  loadCustomerProjectSources,
  readCanonicalSurfaceOutput,
} from "./customer_project_surface_io.mjs";
import { meetingLifecycleState } from "./customer_project_status.mjs";
import { resolveCustomerProjectWorkspace } from "./project_workspace.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const checker = path.join(scriptDir, "check_customer_agent_prd_sources.mjs");
const generator = path.join(scriptDir, "generate_customer_agent_hub.mjs");
const meetingGenerator = path.join(scriptDir, "generate_customer_agent_meeting.mjs");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");

if (args.some((value) => value !== "--check") || args.filter((value) => value === "--check").length > 1) {
  throw new Error("用法：node sync_customer_agent_surfaces.mjs [--check]");
}

const workspace = await resolveCustomerProjectWorkspace(import.meta.url);
const canonicalProjectDir = await realpath(workspace.projectDir);
const surfaceSources = await loadCustomerProjectSources({
  projectDir: workspace.projectDir,
  canonicalProjectDir,
});
const surfaceModel = buildCustomerProjectSurfaceModel(surfaceSources.byId);
const meetingLifecycle = meetingLifecycleState(surfaceModel.projectStatus);
if (meetingLifecycle === "not-eligible") {
  throw new Error("项目批准尚未成立，拒绝同步或校验写有“项目已批准”的启动会视图");
}
const meetingLifecycleClosed = meetingLifecycle === "closed";

function run(label, script, scriptArgs) {
  const result = spawnSync(process.execPath, [script, ...scriptArgs], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const outcome = result.status === null ? `signal ${result.signal || "unknown"}` : `exit ${result.status}`;
    throw new Error(`${label} 失败（${outcome}）`);
  }
}

async function verifyFrozenMeetingSnapshot() {
  const outputPath = path.join(workspace.projectDir, "09-客服Agent需求会汇报.html");
  const snapshot = await readCanonicalSurfaceOutput({
    outputPath,
    canonicalProjectDir,
    label: "启动会冻结快照",
  });
  const { releaseId } = assertSafeMeetingArtifact(snapshot.text);
  console.log(`启动会冻结快照有效 · ${releaseId}`);
}

if (checkOnly) {
  run("Hub 稳定点校验", generator, ["--check"]);
  run("PRD 稳定点校验", checker, ["--check"]);
  if (meetingLifecycleClosed) {
    await verifyFrozenMeetingSnapshot();
    console.log(`客服双视图已在稳定点；需求会视图生命周期已结束，保留历史文件 · ${workspace.mode} · ${workspace.projectDir}`);
  } else {
    run("需求会汇报稳定点校验", meetingGenerator, ["--check"]);
    console.log(`客服三视图已在稳定点 · ${workspace.mode} · ${workspace.projectDir}`);
  }
} else {
  // 第一次 update 把当前 seed Hub 与 7 份真源写入 PRD；生成 Hub 后再次
  // update 消除两页互相内嵌的先后差。需求会前再生成不反向内嵌的会议视图并三重
  // check；一期方向确认或 Ddev 成立后，09 已转为历史快照，不再改写或用新状态校验。
  run("PRD 首轮同步", checker, ["--update"]);
  run("Hub 生成", generator, []);
  run("PRD 收敛同步", checker, ["--update"]);
  if (!meetingLifecycleClosed) run("需求会汇报生成", meetingGenerator, []);
  run("Hub 稳定点校验", generator, ["--check"]);
  run("PRD 稳定点校验", checker, ["--check"]);
  if (meetingLifecycleClosed) {
    await verifyFrozenMeetingSnapshot();
    console.log(`客服双视图已同步并收敛；需求会视图生命周期已结束，保留历史文件 · ${workspace.mode} · ${workspace.projectDir}`);
  } else {
    run("需求会汇报稳定点校验", meetingGenerator, ["--check"]);
    console.log(`客服三视图已同步并收敛 · ${workspace.mode} · ${workspace.projectDir}`);
  }
}
