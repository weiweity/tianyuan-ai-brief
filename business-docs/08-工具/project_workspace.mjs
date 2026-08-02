import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRIVATE_MARKER = ".customer-project-private.json";

const WORKSPACE_MODES = new Set(["public-template", "private"]);
const QA_OUTPUT_DIRECTORIES = Object.freeze({
  prd: "customer-agent-prd-qa",
  hub: "customer-agent-hub-qa",
  meeting: "customer-agent-meeting-qa",
});

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

export async function resolveCustomerProjectWorkspace(moduleUrl, env = process.env) {
  const scriptDir = path.dirname(fileURLToPath(moduleUrl));
  const repoRoot = path.resolve(scriptDir, "../..");
  const defaultProjectDir = path.join(repoRoot, "business-docs/01-客服Agent项目");
  const requestedMode = String(env.CUSTOMER_PROJECT_MODE || "").trim();
  const configured = String(env.CUSTOMER_PROJECT_ROOT || "").trim();

  if (requestedMode && !WORKSPACE_MODES.has(requestedMode)) {
    throw new Error(`不支持的 CUSTOMER_PROJECT_MODE：${requestedMode}`);
  }
  if (!configured) {
    if (requestedMode === "private") {
      throw new Error("CUSTOMER_PROJECT_MODE=private 时必须同时设置 CUSTOMER_PROJECT_ROOT");
    }
    return { mode: "public-template", projectDir: defaultProjectDir, repoRoot };
  }
  if (requestedMode !== "private") {
    throw new Error("设置 CUSTOMER_PROJECT_ROOT 时必须同时设置 CUSTOMER_PROJECT_MODE=private");
  }
  if (!path.isAbsolute(configured)) throw new Error("CUSTOMER_PROJECT_ROOT 必须是绝对路径");
  const configuredStat = await lstat(configured);
  if (configuredStat.isSymbolicLink()) throw new Error("私有客服工作区路径不能是符号链接");
  const projectDir = await realpath(configured);
  const projectStat = await lstat(projectDir);
  if (!projectStat.isDirectory()) throw new Error("私有客服工作区必须是真实目录");
  const canonicalRepo = await realpath(repoRoot);
  if (isWithin(canonicalRepo, projectDir)) throw new Error("私有客服工作区必须位于公开仓库之外");
  const marker = JSON.parse(await readFile(path.join(projectDir, PRIVATE_MARKER), "utf8"));
  if (marker.schemaVersion !== 1 || marker.visibility !== "private") {
    throw new Error("私有客服工作区标记无效；请用 prepare_private_customer_project.mjs 创建");
  }
  return { mode: "private", projectDir, repoRoot };
}

export function resolveCustomerProjectQaPaths(workspace, surface) {
  const outputDirectory = QA_OUTPUT_DIRECTORIES[surface];
  if (!outputDirectory) throw new Error(`不支持的客服 QA 类型：${surface}`);

  if (workspace?.mode === "private") {
    if (!path.isAbsolute(workspace.projectDir || "")) {
      throw new Error("私有客服 QA 需要绝对路径 projectDir");
    }
    return {
      trustedRootPath: workspace.projectDir,
      rootPath: path.join(workspace.projectDir, ".qa-output", outputDirectory),
    };
  }

  if (workspace?.mode === "public-template") {
    if (!path.isAbsolute(workspace.repoRoot || "")) {
      throw new Error("公开模板 QA 需要绝对路径 repoRoot");
    }
    return {
      trustedRootPath: workspace.repoRoot,
      rootPath: path.join(workspace.repoRoot, "output", outputDirectory),
    };
  }

  throw new Error(`无法为未知工作区模式解析 QA 路径：${workspace?.mode || "<empty>"}`);
}
