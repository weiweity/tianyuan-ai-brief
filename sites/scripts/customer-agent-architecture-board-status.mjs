import assert from "node:assert/strict";

const HTML_ESCAPE = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => HTML_ESCAPE[character]);
}

function replaceUnique(value, pattern, replacement, label) {
  assert.equal(pattern.global, true, `${label}替换表达式必须使用 global`);
  assert.equal(typeof replacement, "function", `${label}必须使用函数替换，避免动态文本解释 $& / $1`);
  const matches = [...value.matchAll(pattern)];
  assert.equal(matches.length, 1, `${label}必须且只能命中 1 处，当前 ${matches.length} 处`);
  return value.replace(pattern, replacement);
}

function readDevelopmentShell(projectStatus) {
  const progress = projectStatus.developmentProgress;
  assert.ok(progress && typeof progress === "object", "项目状态缺少结构化产品开发进度");
  if (progress.category === "active") {
    const completed = progress.completedSlices.join("、");
    const hasNumberedNextSlice = Boolean(progress.nextSlice);
    const milestoneCompleted = progress.milestoneState === "COMPLETE";
    const nextAction = hasNumberedNextSlice
      ? `${progress.nextSlice} ${progress.nextSliceName}`
      : progress.nextAction;
    return {
      gateClass: "partial",
      codeStatus: milestoneCompleted
        ? `${progress.milestone} · 已完成（${completed} 已收口）`
        : `${progress.milestone} · 进行中（${completed} 已完成）`,
      currentSummary: milestoneCompleted
        ? `${progress.milestone} 产品实施与退出证据已完成；${progress.gateStatusLabel ? `当前 ${progress.gateStatusLabel}；` : ""}下一动作是${nextAction}（待单独授权）。`
        : hasNumberedNextSlice
        ? `${progress.milestone} 已进入开发中，${completed} 已完成；下一切片为 ${nextAction}。`
        : `${progress.milestone} 已进入开发中，${completed} 已完成；下一动作是${nextAction}（待单独授权）。`,
      footerStatus: milestoneCompleted
        ? `${progress.milestone} · COMPLETE，${nextAction} 待单独授权`
        : hasNumberedNextSlice
        ? `${progress.milestone} · IN_PROGRESS，${completed} 已完成、${nextAction} 待执行`
        : `${progress.milestone} · IN_PROGRESS，${completed} 已完成、${nextAction} 待单独授权`,
    };
  }
  if (progress.category === "completed") {
    return {
      gateClass: "pass",
      codeStatus: `代码开发 · ${progress.state}`,
      currentSummary: `${progress.detail || "当前开发切片已完成"}；下一里程碑仍须独立决定。`,
      footerStatus: `产品开发${progress.state}，下一里程碑未自动放行`,
    };
  }
  if (["paused", "stopped"].includes(progress.category)) {
    return {
      gateClass: "partial",
      codeStatus: `代码开发 · ${progress.state}`,
      currentSummary: `${progress.detail || `产品开发${progress.state}`}；历史 Ddev 不自动恢复开发。`,
      footerStatus: `产品开发${progress.state}，只允许复核恢复 / 终止条件`,
    };
  }
  return {
    gateClass: "todo",
    codeStatus: projectStatus.ddevReady ? "Ddev 已授权 · 代码开发未开始" : "代码开发未开始",
    currentSummary: progress.detail || "代码开发未开始。",
    footerStatus: "代码开发未开始",
  };
}

function readAuthorizationShell(projectStatus) {
  const g0 = projectStatus.g0Ready
    ? `G0=PASS（${projectStatus.g0Evidence}）`
    : `G0=${projectStatus.g0}`;
  const ddev = projectStatus.ddevReady
    ? `Ddev=PASS（${projectStatus.ddevEvidence}）`
    : `Ddev=${projectStatus.ddev}`;
  const counts = `外部责任包 ${projectStatus.externalPass}/${projectStatus.externalTotal}、Scope ${projectStatus.scopePass}/${projectStatus.scopeTotal}`;
  return {
    passed: projectStatus.g0Ready && projectStatus.ddevReady,
    value: projectStatus.ddevReady
      ? "G0 / Ddev Pass"
      : projectStatus.g0Ready
        ? "G0 Pass / 待 Ddev"
        : "G0 / Ddev 未完成",
    summary: `${counts}；${g0}，${ddev}${projectStatus.ddevReady ? "；初始即时范围 DEV-M0，后续里程碑按独立授权与退出证据推进" : ""}`,
  };
}

export function synchronizeBoardStatusShell(board, projectStatus) {
  const development = readDevelopmentShell(projectStatus);
  const authorization = readAuthorizationShell(projectStatus);
  assert.ok(["pass", "partial", "todo"].includes(development.gateClass));
  const currentGate = projectStatus.ddevReady ? "第 4 关代码开发" : "第 3→4 关组织授权门";
  const currentSummary = `${authorization.summary}；${development.currentSummary}${projectStatus.ddevReady ? "真实数据、飞书运行接入、Pilot 与生产仍未放行。" : ""}`;
  const developmentSpan = `<span class="gate ${development.gateClass}" data-current-development>代码开发：${escapeHtml(development.codeStatus)}</span>`;

  if (/data-current-development/.test(board)) {
    board = replaceUnique(
      board,
      /<span class="gate (?:pass|partial|todo)" data-current-development>[\s\S]*?<\/span>/g,
      () => developmentSpan,
      "顶部产品开发状态"
    );
  } else {
    board = replaceUnique(
      board,
      /(<span class="next">)/g,
      (_match, nextSpan) => `${developmentSpan}\n      ${nextSpan}`,
      "顶部产品开发状态插入点"
    );
  }
  board = replaceUnique(
    board,
    /<span class="next">[\s\S]*?<\/span>/g,
    () => `<span class="next">当前推进项：${escapeHtml(currentGate)}；${escapeHtml(currentSummary)}</span>`,
    "顶部当前推进项"
  );
  board = replaceUnique(
    board,
    /<div class="cv-card" role="listitem"><div class="k">组织门禁<\/div><div class="v">[\s\S]*?<\/div><div class="d">[\s\S]*?<\/div><\/div>/g,
    () => `<div class="cv-card" role="listitem"><div class="k">组织门禁</div><div class="v">${escapeHtml(authorization.value)}</div><div class="d">${escapeHtml(`${authorization.summary}。${development.currentSummary}${projectStatus.ddevReady ? "下一里程碑、真实 G1a 及真实运行能力仍须后续门禁。" : "未获 Ddev 前不得开始正式代码开发。"}`)}</div></div>`,
    "组织门禁状态卡"
  );
  board = replaceUnique(
    board,
    /(<section class="panel" id="panel-wf"[\s\S]*?<p class="purpose"><strong>生成状态：<\/strong>)[\s\S]*?(<\/p>)/g,
    (_match, prefix, suffix) => `${prefix}本 Tab 已由当前 PlantUML 与项目状态真源确定性重生成并通过对齐检查：<strong>实现设计已通过；${escapeHtml(currentSummary)}</strong>${suffix}`,
    "瀑布 Tab 生成状态"
  );
  board = replaceUnique(
    board,
    /<tr><td>代码开发<\/td><td>按设计真正写程序。<\/td><td>[\s\S]*?<\/td><\/tr>/g,
    () => `<tr><td>代码开发</td><td>按设计真正写程序。</td><td>${escapeHtml(development.codeStatus)}</td></tr>`,
    "小白版代码开发状态"
  );
  board = replaceUnique(
    board,
    /<p class="cv-note"><strong>小白说明：<\/strong>[\s\S]*?<\/p>/g,
    () => `<p class="cv-note"><strong>小白说明：</strong>${projectStatus.ddevReady ? `Ddev 已签发，${escapeHtml(development.currentSummary)}` : "施工图已经锁定，但组织授权门尚未通过。"}当前证据只覆盖获批的纯合成工程范围；真实来源、飞书运行接入、desktop adapter、Pilot 与生产仍须后续独立门禁。</p>`,
    "小白版当前开发说明"
  );
  board = replaceUnique(
    board,
    /<li><strong>G0\/Ddev 组织授权门（不计入八关）<\/strong>：[\s\S]*?<\/li>/g,
    () => `<li><strong>G0/Ddev 组织授权门（不计入八关）</strong>：它位于第 3 关与第 4 关之间，${authorization.passed ? "现已通过" : "当前尚未全部通过"}；${escapeHtml(authorization.summary)}。${escapeHtml(development.currentSummary)}G0-15 与 Ddev 均不自动授权下一里程碑、真实 G1a、真实数据、飞书运行链路、Pilot、生产发布、付费调用或自动发送。</li>`,
    "小白版组织授权说明"
  );
  board = replaceUnique(
    board,
    /<p><strong>当前推进项：<\/strong>[\s\S]*?<\/p>/g,
    () => `<p><strong>当前推进项：</strong>${escapeHtml(currentGate)}。${escapeHtml(currentSummary)}</p>`,
    "瀑布状态表当前推进项"
  );
  board = replaceUnique(
    board,
    /<tr><th>组织授权门（不计入八关）<\/th><td><span class="gate (?:pass|partial|todo)">[\s\S]*?<\/span><\/td><td>项目\/业务\/预算\/IT安全<\/td><\/tr>/g,
    () => `<tr><th>组织授权门（不计入八关）</th><td><span class="gate ${authorization.passed ? "pass" : "todo"}">${authorization.passed ? "通过" : "未通过"} · ${escapeHtml(authorization.summary)}</span></td><td>项目/业务/预算/IT安全</td></tr>`,
    "瀑布状态表组织授权门"
  );
  board = replaceUnique(
    board,
    /<tr><th>4 代码开发<\/th><td><span class="gate (?:pass|partial|todo)">[\s\S]*?<\/span><\/td><td>开发<\/td><\/tr>/g,
    () => `<tr><th>4 代码开发</th><td><span class="gate ${development.gateClass}">${escapeHtml(development.codeStatus)}</span></td><td>开发</td></tr>`,
    "瀑布状态表代码开发行"
  );
  board = replaceUnique(
    board,
    /(<footer>离线单文件[\s\S]*?当前规范以 37\/39\/40\/46 为准 · )[\s\S]*?( · schema v1\.12)/g,
    (_match, prefix, suffix) => `${prefix}${escapeHtml(authorization.summary)} · 代码开发当前为 ${escapeHtml(development.footerStatus)}${projectStatus.ddevReady ? "；下一里程碑与真实运行能力未自动放行" : ""}${suffix}`,
    "页脚产品开发状态"
  );
  return board;
}
