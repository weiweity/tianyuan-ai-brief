import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCustomerProjectWorkspace } from "./project_workspace.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const checker = path.join(scriptDir, "check_customer_agent_prd_sources.mjs");
const generator = path.join(scriptDir, "generate_customer_agent_hub.mjs");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");

if (args.some((value) => value !== "--check") || args.filter((value) => value === "--check").length > 1) {
  throw new Error("用法：node sync_customer_agent_surfaces.mjs [--check]");
}

const workspace = await resolveCustomerProjectWorkspace(import.meta.url);

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

if (checkOnly) {
  run("Hub 稳定点校验", generator, ["--check"]);
  run("PRD 稳定点校验", checker, ["--check"]);
  console.log(`客服双页已在稳定点 · ${workspace.mode} · ${workspace.projectDir}`);
} else {
  // 第一次 update 把当前 seed Hub 与 7 份真源写入 PRD；生成 Hub 后再次
  // update，消除双页互相内嵌产生的先后差，最后用双 check 证明已到 fixpoint。
  run("PRD 首轮同步", checker, ["--update"]);
  run("Hub 生成", generator, []);
  run("PRD 收敛同步", checker, ["--update"]);
  run("Hub 稳定点校验", generator, ["--check"]);
  run("PRD 稳定点校验", checker, ["--check"]);
  console.log(`客服双页已同步并收敛 · ${workspace.mode} · ${workspace.projectDir}`);
}
