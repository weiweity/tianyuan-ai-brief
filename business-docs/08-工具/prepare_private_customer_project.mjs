import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRIVATE_MARKER } from "./project_workspace.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const sourceDir = path.join(repoRoot, "business-docs/01-客服Agent项目");
const targetArg = process.argv.find((value) => value.startsWith("--target="));
const target = targetArg?.slice("--target=".length) || process.env.CUSTOMER_PROJECT_ROOT || "";
const files = [
  "README.md",
  "00-项目章程.md",
  "01-总排期与阶段门禁.md",
  "02-G0责任与证据台账.md",
  "03-Scope与验收.md",
  "04-费用与成本控制.md",
  "05-全栈交付计划.md",
  "06-启动会与周推进.md",
  "07-客服Agent立项PRD.html",
];

if (!target || !path.isAbsolute(target)) throw new Error("用法：--target=/公开仓外/客服Agent项目（必须是绝对路径）");
const targetDir = path.normalize(target);
const parent = await realpath(path.dirname(targetDir));
const canonicalRepo = await realpath(repoRoot);
const relativeToRepo = path.relative(canonicalRepo, path.join(parent, path.basename(targetDir)));
if (relativeToRepo === "" || (!relativeToRepo.startsWith(`..${path.sep}`) && relativeToRepo !== "..")) {
  throw new Error("私有工作区必须位于公开仓库之外");
}
try {
  await lstat(targetDir);
  throw new Error(`目标已存在，拒绝覆盖：${targetDir}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
await mkdir(targetDir);
for (const file of files) await copyFile(path.join(sourceDir, file), path.join(targetDir, file));
const templateReadme = await readFile(path.join(targetDir, "README.md"), "utf8");
const privateReadme = `> **私有现行工作区：** 本目录由公开模板迁入，允许按内部权限填写受控状态；不得回推公开仓。\n\n${templateReadme}`;
await writeFile(path.join(targetDir, "README.md"), privateReadme, "utf8");
await writeFile(
  path.join(targetDir, PRIVATE_MARKER),
  `${JSON.stringify({ schemaVersion: 1, visibility: "private", source: "public-template", createdAt: new Date().toISOString() }, null, 2)}\n`,
  { flag: "wx" }
);
await writeFile(
  path.join(targetDir, "PRIVATE-WORKSPACE.md"),
  `# 私有客服项目工作区\n\n此目录位于公开仓外，可填写真实 cap 与受控状态；仍建议只在正文保存 EVD / ROLE / USR 代号，原始 PII 和审批原文继续留在受控系统。\n\n## 启用\n\n\`\`\`bash\nexport CUSTOMER_PROJECT_MODE=private\nexport CUSTOMER_PROJECT_ROOT=${JSON.stringify(targetDir)}\nnode ${JSON.stringify(path.join(scriptDir, "check_customer_agent_prd_sources.mjs"))} --update\nnode ${JSON.stringify(path.join(scriptDir, "generate_customer_agent_hub.mjs"))}\n\`\`\`\n\n公开模板导航长度：${privateReadme.length} 字节。\n`,
  { flag: "wx" }
);
console.log(`私有客服工作区已创建：${targetDir}`);
console.log("请设置 CUSTOMER_PROJECT_MODE=private 与 CUSTOMER_PROJECT_ROOT 后再填写真实状态。");
