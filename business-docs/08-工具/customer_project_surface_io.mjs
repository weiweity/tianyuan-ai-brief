import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const CUSTOMER_PROJECT_SOURCE_DEFINITIONS = Object.freeze([
  { id: "charter", file: "00-项目章程.md", label: "项目章程" },
  { id: "schedule", file: "01-总排期与阶段门禁.md", label: "总排期与阶段门禁" },
  { id: "ledger", file: "02-G0责任与证据台账.md", label: "G0 责任与证据台账" },
  { id: "scope", file: "03-Scope与验收.md", label: "Scope 与验收" },
  { id: "cost", file: "04-费用与成本控制.md", label: "费用与成本控制" },
  { id: "delivery", file: "05-全栈交付计划.md", label: "全栈交付计划" },
  { id: "cadence", file: "06-启动会与周推进.md", label: "启动会与周推进" },
]);

// 只参与受控状态推导，不进入现有 7 份对外嵌入真源或其展示计数。
export const CUSTOMER_PROJECT_STATUS_SOURCE_DEFINITIONS = Object.freeze([
  {
    id: "architecture",
    file: "20-设计-进行中/37-架构SSOT-v1.md",
    label: "37 架构 SSOT",
  },
  {
    id: "implementation",
    file: "20-设计-进行中/46-实现设计-开工包.md",
    label: "46 实现设计开工包",
  },
  {
    id: "g0Authorization",
    file: "90-评审/2026-08-31_G0正式签发记录.md",
    label: "G0 正式签发记录",
  },
  {
    id: "ddevAuthorization",
    file: "90-评审/2026-08-31_Ddev正式签发记录.md",
    label: "Ddev 正式签发记录",
  },
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

export async function readRegularFileNoFollow(filePath, { allowedRoot, label }) {
  const fileStat = await lstat(filePath);
  if (fileStat.isSymbolicLink()) throw new Error(`${label}不能是符号链接：${filePath}`);
  if (!fileStat.isFile()) throw new Error(`${label}必须是普通文件：${filePath}`);

  const canonicalFile = await realpath(filePath);
  if (!isWithin(allowedRoot, canonicalFile)) {
    throw new Error(`${label}真实路径越出允许目录：${canonicalFile}`);
  }

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(filePath, flags);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error(`${label}必须是普通文件：${filePath}`);
    return await handle.readFile("utf8");
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`${label}不能是符号链接：${filePath}`);
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function loadCustomerProjectSources({ projectDir, canonicalProjectDir }) {
  const loadEntries = (definitions) =>
    Promise.all(
      definitions.map(async (source) => {
        const sourcePath = path.join(projectDir, source.file);
        const text = await readRegularFileNoFollow(sourcePath, {
          allowedRoot: canonicalProjectDir,
          label: `真源 ${source.file} `,
        });
        return { ...source, sourcePath, text, hash: sha256(text) };
      })
    );
  const [entries, statusEntries] = await Promise.all([
    loadEntries(CUSTOMER_PROJECT_SOURCE_DEFINITIONS),
    loadEntries(CUSTOMER_PROJECT_STATUS_SOURCE_DEFINITIONS),
  ]);
  return {
    entries,
    statusEntries,
    byId: Object.fromEntries(
      [...entries, ...statusEntries].map((source) => [source.id, source.text])
    ),
    fingerprint: sha256(
      [...entries, ...statusEntries]
        .map((source) => `${source.file}:${source.hash}`)
        .join("\n")
    ),
  };
}

export function extractPretextVendor(prdHtml, label = "PRD") {
  const match = [...prdHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].find(
    ([, attributes]) =>
      /\bid=["']pretext-source["']/i.test(attributes) &&
      /\btype=["']text\/plain["']/i.test(attributes)
  );
  if (!match || match[2].trim().length < 1000) {
    throw new Error(`无法从已跟踪 ${label} 提取 Pretext`);
  }
  const source = match[2].trim();
  if (!source.includes("export{") || !source.includes("prepare")) {
    throw new Error(`${label} 中的 pretext-source 不是预期的模块源码`);
  }
  return source;
}

async function readOutput(outputPath, { canonicalProjectDir, label, optional = false }) {
  let outputStat;
  try {
    outputStat = await lstat(outputPath);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return { text: null, mode: 0o644 };
    throw error;
  }
  if (outputStat.isSymbolicLink()) throw new Error(`${label}输出文件不能是符号链接`);
  if (!outputStat.isFile()) throw new Error(`${label}输出必须是普通文件：${outputPath}`);
  const canonicalOutput = await realpath(outputPath);
  if (!isWithin(canonicalProjectDir, canonicalOutput)) {
    throw new Error(`${label}输出真实路径越出客服项目根目录：${canonicalOutput}`);
  }

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(outputPath, flags);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error(`${label}输出必须是普通文件：${outputPath}`);
    return { text: await handle.readFile("utf8"), mode: Number(openedStat.mode & 0o777) };
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`${label}输出文件不能是符号链接`);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function removeExactTemporary(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function readCanonicalSurfaceOutput(options) {
  return readOutput(options.outputPath, options);
}

export async function writeCanonicalSurfaceOutputIfChanged({
  outputPath,
  canonicalOutputPath,
  canonicalProjectDir,
  generated,
  expectedSourceFingerprint,
  readSourceFingerprint,
  label,
}) {
  if (path.resolve(outputPath) !== path.resolve(canonicalOutputPath)) {
    throw new Error(`${label}输出只允许 canonical 文件：${canonicalOutputPath}`);
  }
  if (!isWithin(canonicalProjectDir, path.resolve(outputPath))) {
    throw new Error(`${label}输出越出客服项目根目录：${outputPath}`);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  const lockPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.write.lock`);
  let lockHandle;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
    await lockHandle.writeFile(`${process.pid}\n`, "utf8");
    await lockHandle.sync();
  } catch (error) {
    await lockHandle?.close().catch(() => {});
    if (error?.code === "EEXIST") {
      throw new Error(`${label}生成锁已被占用，拒绝并发覆盖：${lockPath}`);
    }
    throw error;
  }

  let handle;
  let temporaryPath;
  try {
    const before = await readOutput(outputPath, { canonicalProjectDir, label, optional: true });
    if (before.text === generated) return false;

    temporaryPath = path.join(
      path.dirname(outputPath),
      `.${path.basename(outputPath)}.update-${process.pid}-${randomUUID()}.tmp`
    );
    handle = await open(temporaryPath, "wx", before.mode || 0o644);
    await handle.chmod(before.mode || 0o644);
    await handle.writeFile(generated, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (readSourceFingerprint) {
      const currentSourceFingerprint = await readSourceFingerprint();
      if (currentSourceFingerprint !== expectedSourceFingerprint) {
        throw new Error(`${label}真源在生成期间发生变化，已拒绝输出`);
      }
    }
    const current = await readOutput(outputPath, { canonicalProjectDir, label, optional: true });
    if (current.text !== before.text) {
      throw new Error(`${label}输出在生成期间发生变化，已拒绝覆盖`);
    }
    await rename(temporaryPath, outputPath);
    return true;
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryPath) await removeExactTemporary(temporaryPath).catch(() => {});
    await lockHandle?.close().catch(() => {});
    await removeExactTemporary(lockPath).catch(() => {});
  }
}
