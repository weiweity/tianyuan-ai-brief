/**
 * 项目级立项决策模型。
 *
 * 这是页面里唯一允许解释 A / B / C、散会门禁与会议凭证的模块。
 * UI 只负责收集状态；结论、缺项和凭证均由这里统一计算。
 */

export const PATH_LABELS = Object.freeze({
  A: "A 同意启动",
  B: "B 先认方向",
  C: "C 不立",
});

const RECEIPT_VERSION = 1;

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function plainHtml(value) {
  return clean(value)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function moneyNumber(value) {
  const normalized = clean(value).replace(/[,\s￥¥元]/g, "");
  if (!normalized) return NaN;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function namedOwnersOf(row) {
  if (!row) return [];
  if (Array.isArray(row.owners)) {
    return row.owners.filter((owner) => owner && clean(owner.name));
  }
  if (row.ownerFields && clean(row.ownerFields.name)) {
    return [row.ownerFields];
  }
  return [];
}

function projectLabel(row) {
  return clean(row.projectLabel || row.projectId || plainHtml(row.html) || row.no);
}

function feeValidation(row) {
  if (!row || !row.feeFields) {
    return { valid: false, reason: "未设置费用与止损" };
  }
  const fields = row.feeFields;
  const total = moneyNumber(fields.total);
  const monthCap = moneyNumber(fields.monthCap);
  const allCap = moneyNumber(fields.allCap);
  if (![total, monthCap, allCap].every((value) => Number.isFinite(value) && value > 0)) {
    return { valid: false, reason: "费用或止损线不是有效正数" };
  }
  if (monthCap > allCap) {
    return { valid: false, reason: "首月止损不能高于全期止损" };
  }
  if (total > allCap) {
    return { valid: false, reason: "目标预算不能高于全期止损" };
  }
  return { valid: true, total, monthCap, allCap };
}

/**
 * 散会最低要求：
 * - 每个候选项目必须独立选择 A / B / C；
 * - A / B 项目必须分别具名 Owner；
 * - 只要存在 A / B，就必须确认共享费用口径与超线停扩权；
 * - 全部 C 时，项目路径本身即构成完整结论。
 */
export function evaluateCheckGate(block) {
  const rows = Array.isArray(block && block.rows) ? block.rows : [];
  const pathRows = rows.filter(
    (row) => row && row.projectId && Array.isArray(row.pathOptions) && row.pathOptions.length
  );
  const decisions = pathRows.map((row) => ({
    projectId: clean(row.projectId),
    projectLabel: projectLabel(row),
    path: clean(row.pathValue),
    pathLabel: PATH_LABELS[row.pathValue] || "未选",
    row,
  }));
  const activeDecisions = decisions.filter((decision) => decision.path === "A" || decision.path === "B");
  const missing = [];

  decisions.forEach((decision) => {
    if (!decision.path) missing.push(decision.projectLabel + "路径");
  });
  if (!decisions.length) missing.push("项目级路径");

  const feeRow = rows.find((row) => row && (row.kind === "fee" || row.feeFields));
  const stopRow = rows.find(
    (row) => row && (row.kind === "stop-authority" || String(row.no) === "6")
  );
  const ownerRows = rows.filter(
    (row) => row && (row.kind === "owner" || Array.isArray(row.owners) || row.ownerFields)
  );

  if (activeDecisions.length) {
    activeDecisions.forEach((decision) => {
      const ownerRow = ownerRows.find((row) => clean(row.projectId) === decision.projectId);
      if (!ownerRow || !ownerRow.checked || !namedOwnersOf(ownerRow).length) {
        missing.push(decision.projectLabel + " Owner");
      }
    });

    const feeCheck = feeValidation(feeRow);
    if (!feeRow || !feeRow.checked) {
      missing.push("费用与止损确认");
    } else if (!feeCheck.valid) {
      missing.push(feeCheck.reason);
    }
    if (!stopRow || !stopRow.checked) missing.push("超线停扩授权");
  }

  const done = rows.filter(
    (row) => row && (row.checked || (Array.isArray(row.pathOptions) && row.pathValue))
  ).length;
  const selectedDecisions = decisions.filter((decision) => decision.path);
  const allPathsChosen = decisions.length > 0 && selectedDecisions.length === decisions.length;
  const allC = allPathsChosen && decisions.every((decision) => decision.path === "C");
  const isMinOk = allPathsChosen && missing.length === 0;
  const pathLab = decisions.length
    ? decisions
        .map((decision) => `${decision.projectLabel} ${decision.path || "未选"}`)
        .join(" · ")
    : "项目路径未配置";

  return {
    rows,
    total: rows.length,
    done,
    decisions,
    activeDecisions,
    ownerRows,
    feeRow,
    stopRow,
    missing: [...new Set(missing)],
    allPathsChosen,
    allC,
    isMinOk,
    path: decisions.length === 1 ? decisions[0].path : "",
    pathLab,
  };
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function rightRotate(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

/** 同步 SHA-256，保证点击事件内即可复制含哈希的凭证。 */
export function sha256(input) {
  const bytes = new TextEncoder().encode(String(input));
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ]);
  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const w15 = words[i - 15];
      const w2 = words[i - 2];
      const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
      const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + constants[i] + words[i]) >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return [...hash].map((value) => value.toString(16).padStart(8, "0")).join("");
}

function ownerSnapshot(row) {
  return namedOwnersOf(row).map((owner) => ({
    name: clean(owner.name),
    dept: clean(owner.dept),
    scope: clean(owner.scope || owner.backup),
  }));
}

export function buildDecisionReceipt(block, context = {}) {
  const gate = evaluateCheckGate(block);
  const generatedAt = context.generatedAt || new Date().toISOString();
  const ownerByProject = {};
  gate.ownerRows.forEach((row) => {
    if (row.projectId) ownerByProject[row.projectId] = ownerSnapshot(row);
  });
  const feeFields = gate.feeRow && gate.feeRow.feeFields;
  const payload = {
    receiptVersion: RECEIPT_VERSION,
    kind: "ai-project-decision-draft",
    generatedAt,
    contentVersion: clean(context.contentVersion),
    decisionSchemaVersion: Number(context.decisionSchemaVersion || 1),
    sourceStamp: clean(context.sourceStamp),
    localDraft: true,
    projects: gate.decisions.map((decision) => ({
      projectId: decision.projectId,
      projectLabel: decision.projectLabel,
      path: decision.path || null,
      pathLabel: decision.path ? PATH_LABELS[decision.path] || decision.path : null,
      owners: ownerByProject[decision.projectId] || [],
    })),
    fees: feeFields
      ? {
          total: clean(feeFields.total),
          monthCap: clean(feeFields.monthCap),
          allCap: clean(feeFields.allCap),
          otherNote: clean(feeFields.otherNote),
          confirmed: Boolean(gate.feeRow.checked),
        }
      : null,
    stopAuthorityConfirmed: Boolean(gate.stopRow && gate.stopRow.checked),
    minimumReady: gate.isMinOk,
    missing: gate.missing,
    acknowledgements: gate.rows
      .filter((row) => !row.projectId && !row.feeFields)
      .map((row) => ({
        rowId: clean(row.rowId),
        no: clean(row.no),
        label: plainHtml(row.html),
        checked: Boolean(row.checked),
      })),
  };
  const digest = sha256(canonicalJson(payload));
  return {
    ...payload,
    integrity: {
      algorithm: "SHA-256",
      canonicalization: "sorted-key-json-v1",
      digest,
    },
  };
}

export function verifyDecisionReceipt(receipt) {
  if (!receipt || !receipt.integrity || receipt.integrity.algorithm !== "SHA-256") return false;
  const payload = { ...receipt };
  const expected = payload.integrity.digest;
  delete payload.integrity;
  return sha256(canonicalJson(payload)) === expected;
}

export function buildMeetingConclusionText(block, context = {}) {
  const gate = evaluateCheckGate(block);
  const receipt = context.receipt || buildDecisionReceipt(block, context);
  const stamp = new Date(receipt.generatedAt);
  const displayStamp = Number.isNaN(stamp.getTime())
    ? receipt.generatedAt
    : stamp.toLocaleString("zh-CN", { hour12: false });
  const lines = ["【AI 赋能立项 · 本场结论】", `时间：${displayStamp}`];

  gate.decisions.forEach((decision) => {
    lines.push(
      `项目：${decision.projectLabel} · 路径：${
        decision.path ? PATH_LABELS[decision.path] || decision.path : "未选"
      }`
    );
    const ownerRow = gate.ownerRows.find((row) => clean(row.projectId) === decision.projectId);
    const owners = ownerSnapshot(ownerRow);
    lines.push(
      `Owner：${
        owners.length
          ? owners
              .map(
                (owner) =>
                  `${owner.name}${owner.dept ? " / " + owner.dept : ""}${
                    owner.scope ? " / " + owner.scope : ""
                  }`
              )
              .join("；")
          : "（未填）"
      }`
    );
  });

  if (receipt.fees) {
    lines.push(
      `费用口径：目标 ${receipt.fees.total || "—"} 元 · 首月止损 ${
        receipt.fees.monthCap || "—"
      } 元 · 全期止损 ${receipt.fees.allCap || "—"} 元${
        receipt.fees.otherNote ? " · " + receipt.fees.otherNote : ""
      }`
    );
  }
  lines.push(`超线停扩授权：${receipt.stopAuthorityConfirmed ? "已确认" : "未确认"}`);
  lines.push(
    gate.isMinOk
      ? "散会最低要求：已齐"
      : `散会最低要求：未齐 · 还缺 ${gate.missing.join(" · ") || "项目级路径"}`
  );

  const aProjects = gate.decisions.filter((decision) => decision.path === "A");
  const bProjects = gate.decisions.filter((decision) => decision.path === "B");
  const cProjects = gate.decisions.filter((decision) => decision.path === "C");
  if (aProjects.length) {
    lines.push(`A 路径会后：${aProjects.map((item) => item.projectLabel).join("、")} 按门禁与止损线启动`);
  }
  if (bProjects.length) {
    lines.push(`B 路径会后：${bProjects.map((item) => item.projectLabel).join("、")} 只补前置，未批不开发`);
  }
  if (cProjects.length) {
    lines.push(`C 路径会后：${cProjects.map((item) => item.projectLabel).join("、")} 记录不立原因，不排期`);
  }
  lines.push("本场边界：不承诺立刻上线 · 不自动代回客户 · 金额以确认的止损线为准");
  lines.push(`凭证哈希（SHA-256）：${receipt.integrity.digest}`);
  lines.push("— 本机会议草稿：贴入飞书 / 邮件并由相关人确认后才构成正式留痕 —");
  return lines.join("\n");
}
