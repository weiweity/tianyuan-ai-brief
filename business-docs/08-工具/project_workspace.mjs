import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRIVATE_MARKER = ".customer-project-private.json";

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export async function resolveCustomerProjectWorkspace(moduleUrl, env = process.env) {
  const scriptDir = path.dirname(fileURLToPath(moduleUrl));
  const repoRoot = path.resolve(scriptDir, "../..");
  const defaultProjectDir = path.join(repoRoot, "business-docs/01-客服Agent项目");
  const configured = String(env.CUSTOMER_PROJECT_ROOT || "").trim();
  if (!configured) return { mode: "public-template", projectDir: defaultProjectDir, repoRoot };
  if (env.CUSTOMER_PROJECT_MODE !== "private") {
    throw new Error("设置 CUSTOMER_PROJECT_ROOT 时必须同时设置 CUSTOMER_PROJECT_MODE=private");
  }
  if (!path.isAbsolute(configured)) throw new Error("CUSTOMER_PROJECT_ROOT 必须是绝对路径");
  const projectDir = await realpath(configured);
  const projectStat = await lstat(projectDir);
  if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) throw new Error("私有客服工作区必须是真实目录，不能是符号链接");
  const canonicalRepo = await realpath(repoRoot);
  if (isWithin(canonicalRepo, projectDir)) throw new Error("私有客服工作区必须位于公开仓库之外");
  const marker = JSON.parse(await readFile(path.join(projectDir, PRIVATE_MARKER), "utf8"));
  if (marker.schemaVersion !== 1 || marker.visibility !== "private") {
    throw new Error("私有客服工作区标记无效；请用 prepare_private_customer_project.mjs 创建");
  }
  return { mode: "private", projectDir, repoRoot };
}
