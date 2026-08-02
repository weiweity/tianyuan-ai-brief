import { lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import path from "node:path";

const SAFE_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

export function validateResultToken(value, label = "结果标识") {
  const token = String(value ?? "");
  if (!SAFE_TOKEN.test(token)) {
    throw new Error(`${label}只能使用 1–64 位字母、数字、点、下划线或短横线`);
  }
  return token;
}

export function assertStrictDescendant(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`结果目录必须位于固定根目录 ${root} 的严格子目录中`);
  }
  return candidate;
}

async function ensureSafeParent(root, parent) {
  const canonicalRoot = await realpath(root);
  let current = root;
  const relative = path.relative(root, parent);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const next = path.join(current, segment);
    let info;
    try {
      info = await lstat(next);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(next, { recursive: false });
      info = await lstat(next);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`结果目录父路径不得包含符号链接或非目录：${next}`);
    }
    assertStrictDescendant(canonicalRoot, path.join(await realpath(next), ".result-probe"));
    current = next;
  }
}

export async function createSafeResultsDir({
  trustedRootPath,
  rootPath,
  prefix,
  label,
  requestedPath,
}) {
  const trustedRoot = path.resolve(trustedRootPath);
  const root = path.resolve(rootPath);
  assertStrictDescendant(trustedRoot, root);
  const safePrefix = validateResultToken(prefix, "结果目录前缀");
  const safeLabel = validateResultToken(label, "运行轮次");
  await ensureSafeParent(trustedRoot, root);

  if (requestedPath) {
    const candidate = assertStrictDescendant(root, requestedPath);
    const parent = path.dirname(candidate);
    await ensureSafeParent(root, parent);
    await mkdir(candidate, { recursive: false });
    return candidate;
  }

  return mkdtemp(path.join(root, `${safePrefix}-${safeLabel}-`));
}
