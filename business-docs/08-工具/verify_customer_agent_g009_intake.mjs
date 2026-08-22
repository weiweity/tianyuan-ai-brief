#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const G009_DOMAINS = Object.freeze(["presale", "campaign", "aftersale", "product"]);
export const G009_ROW_FIELDS = Object.freeze([
  "domain", "source_ref", "source_version_id", "snapshot_evd", "acl_evd",
  "total_rows", "importable_rows", "quarantined_rows", "quality_evd",
  "final_approver_role", "overall_approval_evd", "readiness",
]);

const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "evidenceId", "domains"]);
const ROW_FIELD_SET = new Set(G009_ROW_FIELDS);
const SOURCE_REF_RE = /^SRC-[A-Z0-9]{12,32}$/;
const SOURCE_VERSION_RE = /^srcv_[a-z0-9]{16,32}$/;
const EVIDENCE_RE = /^EVD-[A-Z0-9][A-Z0-9._+-]{2,127}$/;
const OVERALL_EVIDENCE_RE = /^EVD-G0-09-AUTHORITY-SOURCES-(\d{8})$/;
const SENSITIVE_VALUE_RE = /(?:https?:\/\/|(?:feishu|larksuite)\.(?:cn|com)|\b(?:doc_token|wiki_token|file_token|tenant_access_token|open_id)\s*[=:]|\b(?:ou_|oc_|on_)[A-Za-z0-9_-]{8,}|\b[A-Fa-f0-9]{64}\b)/i;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} 含未授权字段：${key}`);
  }
}

function assertSafeStrings(value, label = "manifest") {
  if (typeof value === "string") {
    if (SENSITIVE_VALUE_RE.test(value)) {
      throw new Error(`${label} 含 URL、token、实体 ID 或原始 SHA；公开安全投影禁止保存这些值`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeStrings(item, `${label}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) assertSafeStrings(item, `${label}.${key}`);
  }
}

function isRealCalendarDate(yyyymmdd) {
  const match = String(yyyymmdd).match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) && date.getUTCDate() === Number(day);
}

function isBlank(value) {
  return value === "" || value === null || value === undefined;
}

function validateOptionalPattern(value, pattern, label) {
  if (!isBlank(value) && (typeof value !== "string" || !pattern.test(value))) {
    throw new Error(`${label} 格式无效`);
  }
}

function validateOptionalEvidence(value, label) {
  validateOptionalPattern(value, EVIDENCE_RE, label);
}

function numericState(row, domain) {
  const fields = ["total_rows", "importable_rows", "quarantined_rows"];
  const present = fields.filter((field) => !isBlank(row[field]));
  if (present.length === 0) return null;
  if (present.length !== fields.length) throw new Error(`${domain} 的质量计数必须三项同时填写`);
  const values = Object.fromEntries(fields.map((field) => [field, row[field]]));
  for (const [field, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${domain}.${field} 必须为非负整数`);
  }
  if (values.total_rows <= 0) throw new Error(`${domain}.total_rows 必须大于 0`);
  if (values.importable_rows + values.quarantined_rows !== values.total_rows) {
    throw new Error(`${domain} 质量分母不守恒：importable_rows + quarantined_rows 必须等于 total_rows`);
  }
  return values;
}

function missingReadyFields(row) {
  return G009_ROW_FIELDS.filter((field) => !["domain", "readiness"].includes(field) && isBlank(row[field]));
}

function validateRow(row, expectedDomain, overallEvidence) {
  if (!isPlainObject(row)) throw new Error(`${expectedDomain} 行必须是对象`);
  assertAllowedKeys(row, ROW_FIELD_SET, `${expectedDomain} 行`);
  if (row.domain !== expectedDomain) throw new Error(`domain 必须为 ${expectedDomain}`);
  if (!new Set(["INCOMPLETE", "READY"]).has(row.readiness)) {
    throw new Error(`${expectedDomain}.readiness 只允许 INCOMPLETE 或 READY`);
  }
  validateOptionalPattern(row.source_ref, SOURCE_REF_RE, `${expectedDomain}.source_ref`);
  validateOptionalPattern(row.source_version_id, SOURCE_VERSION_RE, `${expectedDomain}.source_version_id`);
  validateOptionalEvidence(row.snapshot_evd, `${expectedDomain}.snapshot_evd`);
  validateOptionalEvidence(row.acl_evd, `${expectedDomain}.acl_evd`);
  validateOptionalEvidence(row.quality_evd, `${expectedDomain}.quality_evd`);
  validateOptionalPattern(row.overall_approval_evd, OVERALL_EVIDENCE_RE, `${expectedDomain}.overall_approval_evd`);
  if (!isBlank(row.final_approver_role) && row.final_approver_role !== "ROLE-CONTENT-LEAD") {
    throw new Error(`${expectedDomain}.final_approver_role 必须为 ROLE-CONTENT-LEAD`);
  }
  numericState(row, expectedDomain);
  const missing = missingReadyFields(row);
  if (row.readiness === "READY") {
    if (missing.length > 0) throw new Error(`${expectedDomain} 标为 READY 但仍缺：${missing.join(", ")}`);
    if (row.final_approver_role !== "ROLE-CONTENT-LEAD") {
      throw new Error(`${expectedDomain} READY 必须由 ROLE-CONTENT-LEAD 最终批准`);
    }
    if (row.overall_approval_evd !== overallEvidence) {
      throw new Error(`${expectedDomain} READY 的 overall_approval_evd 必须与整体证据一致`);
    }
  }
  return { domain: expectedDomain, readiness: row.readiness, missing };
}

export function validateG009IntakeManifest(manifest) {
  if (!isPlainObject(manifest)) throw new Error("manifest 顶层必须是对象");
  assertAllowedKeys(manifest, TOP_LEVEL_FIELDS, "manifest");
  assertSafeStrings(manifest);
  if (manifest.schemaVersion !== 1) throw new Error("schemaVersion 必须为 1");
  if (!Array.isArray(manifest.domains)) throw new Error("domains 必须是数组");
  if (manifest.domains.length !== G009_DOMAINS.length) throw new Error("domains 必须恰好包含四域");
  const byDomain = new Map();
  for (const row of manifest.domains) {
    if (!isPlainObject(row) || !G009_DOMAINS.includes(row.domain)) throw new Error("domains 含未知业务域");
    if (byDomain.has(row.domain)) throw new Error(`domains 重复：${row.domain}`);
    byDomain.set(row.domain, row);
  }
  for (const domain of G009_DOMAINS) if (!byDomain.has(domain)) throw new Error(`domains 缺少：${domain}`);
  if (!isBlank(manifest.evidenceId)) {
    const match = String(manifest.evidenceId).match(OVERALL_EVIDENCE_RE);
    if (!match || !isRealCalendarDate(match[1])) throw new Error("evidenceId 必须是带有效日期的 G0-09 整体证据 ID");
  }
  const domainResults = G009_DOMAINS.map((domain) => validateRow(byDomain.get(domain), domain, manifest.evidenceId));
  const ready = domainResults.every((item) => item.readiness === "READY");
  if (ready && isBlank(manifest.evidenceId)) throw new Error("四域 READY 时必须填写整体 evidenceId");
  return {
    schemaVersion: 1,
    status: ready ? "READY_FOR_G0_UPDATE" : "INCOMPLETE",
    readyDomains: domainResults.filter((item) => item.readiness === "READY").map((item) => item.domain),
    incompleteDomains: domainResults.filter((item) => item.readiness !== "READY").map((item) => item.domain),
    missingByDomain: Object.fromEntries(domainResults.map((item) => [item.domain, item.missing])),
    doesNotAuthorize: ["G0-09", "Scope#9", "G0-signature", "Ddev", "code-development"],
  };
}

function usage() {
  return [
    "用法：node business-docs/08-工具/verify_customer_agent_g009_intake.mjs --manifest=/受控路径/manifest.json [--require-ready]",
    "",
    "默认只做结构与安全投影预检；INCOMPLETE 会正常输出缺项，不推进任何门禁。",
    "--require-ready 会在四域未全部 READY 时以 exit 2 退出，适合最终签发前 fail-closed 检查。",
    "输入不得包含飞书 URL/token、真实标题、原始 SHA、成员清单或审批原文。",
  ].join("\n");
}

function parseArgs(argv) {
  let manifestPath = null;
  let requireReady = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { help: true, manifestPath, requireReady };
    if (arg === "--require-ready") { requireReady = true; continue; }
    if (arg.startsWith("--manifest=")) { manifestPath = path.resolve(arg.slice("--manifest=".length)); continue; }
    throw new Error(`未知参数：${arg}`);
  }
  if (!manifestPath) throw new Error("必须提供 --manifest=/绝对或相对路径/manifest.json");
  return { help: false, manifestPath, requireReady };
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(usage()); return 0; }
  const parsed = JSON.parse(await readFile(args.manifestPath, "utf8"));
  const result = validateG009IntakeManifest(parsed);
  console.log(JSON.stringify(result, null, 2));
  if (args.requireReady && result.status !== "READY_FOR_G0_UPDATE") return 2;
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCli().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`G0-09 接收预检失败：${error.message}`);
    process.exitCode = 1;
  });
}
