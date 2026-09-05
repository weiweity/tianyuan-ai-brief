"""Structural tests for architecture SSOT — drives real files on disk.

These tests assert *contract completeness*, not scorecard vanity metrics.
Run: python3 test_arch_ssot_invariants.py
"""
from __future__ import annotations

import hashlib
import re
import sys
from decimal import Decimal
from pathlib import Path

DESIGN = Path(__file__).resolve().parents[1]
DEVELOPMENT = DESIGN.parent / "30-开发-进行中"
HISTORY = DESIGN.parent / "99-历史" / "2026-08-06-架构设计收口"
IMPORT_ISSUE_CODES = {
    "MISSING_REQUIRED_FIELD",
    "INVALID_FIELD_TYPE",
    "INVALID_VALUE",
    "DUPLICATE_SCRIPT_ID",
    "UNKNOWN_SCRIPT_ID",
    "INVALID_EFFECTIVE_WINDOW",
    "MISSING_EFFECTIVE_WINDOW",
    "HASH_MISMATCH",
    "UNSUPPORTED_FORMAT",
    "MACRO_DETECTED",
    "EXTERNAL_LINK_DETECTED",
    "ROW_LIMIT_EXCEEDED",
    "CONTENT_TOO_LARGE",
    "SOURCE_NOT_REGISTERED",
    "SOURCE_NOT_CANONICAL",
    "SOURCE_SUSPENDED",
    "SOURCE_DOMAIN_MISMATCH",
    "SOURCE_SNAPSHOT_MISMATCH",
    "SOURCE_SET_INCOMPLETE",
    "MISSING_PLATFORM_SCOPE",
    "INVALID_PRODUCT_SCOPE",
    "INVALID_TAXONOMY_REF",
    "INVALID_QUESTION_IDENTITY",
    "INVALID_REVIEW_EVIDENCE",
    "INVALID_PLACEHOLDER_TEMPLATE",
    "GOVERNANCE_HASH_MISMATCH",
}

SCHEMA_VERSION = "schema.v1.14"
SCHEMA_SHA256 = "edf909bf9450b5745a85ced4a75a2e2de3e5b061847562cd3a68c9c7c226da99"
DEV_M1_SCHEMA_V1_13_SHA256 = "de8b7d9bdcac4ecad844025a47228ba339dad47d61861d261c492cb16a1aea02"
DEV_M0_SCHEMA_VERSION = "schema.v1.12"
DEV_M0_SCHEMA_SHA256 = "47b667958e522a28df1c04d7c79a56c930bfe0ac04598321824b55744ac4a801"
OPENAPI_VERSION = "1.11.0"
OPENAPI_SHA256 = "06698f233702591c8f981c7b08ebac4b7d5bc5cc2d69d36014ef2a9f5a6802e4"
GRAMMAR_SHA256 = "11a37902e36b5424cb28ee35cd196f63aac3a1d464a94ed504a712e4ce401b12"
GRAMMAR_SQL_STATEMENTS = 513
GRAMMAR_FUNCTION_BODIES = 89
GRAMMAR_DEC042_GUARDS = 20


def _read(name: str) -> str:
    p = DESIGN / name
    assert p.is_file(), f"missing {p}"
    return p.read_text(encoding="utf-8")


def _read_history(name: str) -> str:
    p = HISTORY / name
    assert p.is_file(), f"missing archived document {p}"
    return p.read_text(encoding="utf-8")


def _read_development(name: str) -> str:
    p = DEVELOPMENT / name
    assert p.is_file(), f"missing development increment {p}"
    return p.read_text(encoding="utf-8")


def _between(text: str, start: str, end: str | None = None) -> str:
    """Return one named contract section, failing if its boundary disappears."""
    start_at = text.find(start)
    assert start_at >= 0, f"missing section start: {start}"
    if end is None:
        return text[start_at:]
    end_at = text.find(end, start_at + len(start))
    assert end_at >= 0, f"missing section end: {end}"
    return text[start_at:end_at]


def _assert_same_line(text: str, *parts: str) -> None:
    """Assert related requirements occur in one Markdown/table line."""
    assert any(all(part in line for part in parts) for line in text.splitlines()), (
        "missing same-line contract: " + " + ".join(parts)
    )


def _strip_sql_comments(sql: str) -> str:
    """Remove SQL comments so commented migration examples cannot satisfy ACL tests."""
    sql = re.sub(r"/\*.*?\*/", "", sql, flags=re.S)
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def _sql_function(sql: str, name: str) -> str:
    match = re.search(
        rf"CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?{re.escape(name)}\s*\(.*?\$\$;",
        sql,
        flags=re.I | re.S,
    )
    assert match, f"missing SQL function {name}"
    return match.group(0)


def _sql_function_last(sql: str, name: str) -> str:
    """Return the effective final definition when reference DDL replaces a bootstrap helper."""
    matches = re.findall(
        rf"CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?{re.escape(name)}\s*\(.*?\$\$;",
        sql,
        flags=re.I | re.S,
    )
    assert matches, f"missing SQL function {name}"
    return matches[-1]


def _html_attrs(tag: str) -> dict[str, str]:
    return dict(re.findall(r"([\w:-]+)=\"([^\"]*)\"", tag))


def _openapi_operations(text: str) -> set[tuple[str, str]]:
    """Extract path/method pairs without making PyYAML a test dependency."""
    operations: set[tuple[str, str]] = set()
    current_path: str | None = None
    for line in text.splitlines():
        path_match = re.match(r"^  (/v1/[^:]+):\s*$", line)
        if path_match:
            current_path = path_match.group(1)
            continue
        method_match = re.match(r"^    (get|post|put|patch|delete):\s*$", line)
        if current_path and method_match:
            operations.add((method_match.group(1).upper(), current_path))
    return operations


def test_architecture_ssot_north_star() -> None:
    t = _read("37-架构SSOT-v1.md")
    assert "PostgreSQL" in t
    assert "权威" in t or "SoR" in t
    assert "Publish" in t or "发布" in t
    assert "公告" in t or "Announce" in t
    assert "rewrite" in t.lower() or "不改字" in t or "禁改写" in t
    assert "浮窗" in t and "Dashboard" in t
    assert "非北极星" in t or "不是**架构" in t or "仅业务" in t
    # v1.1: API contract + INV
    assert "39" in t
    assert "INV-EFF" in t or "v_scripts_recommendable" in t
    assert "INV-ADOPT" in t or "clipboard" in t
    _assert_same_line(t, "阶段", "G0=", "Ddev=", "DEV-M0 · IN_PROGRESS", "W0", "W1")
    _assert_same_line(t, "Code Development", "DEV-M0 IN PROGRESS", "W0 COMPLETE")
    for stale_status in (
        "DEV-M0 Ready · 未开始",
        "DEV-M0 READY / NOT STARTED",
        "代码开发尚未开始",
        "仅 DEV-M0 Ready",
    ):
        assert stale_status not in t, f"architecture SSOT revives stale development status: {stale_status}"


def test_contract_defers_and_honest_push() -> None:
    t = _read("31-产品契约-v1.md")
    assert "37" in t
    assert "剪贴板" in t or "复制" in t
    assert "PostgreSQL" in t or "Postgres" in t
    assert "演示可不做过滤" not in t


def test_prd_no_autofill_first_or_demo_skip_expiry() -> None:
    t = _read("25-PRD草案-客服Agent一期.md")
    forbidden = [
        "自动填优先",
        "自动填写优先",
        "优先尝试自动填入",
        "优先尝试自动填",
        "演示可不做",
        "演示不强制演过期",
        "可不做「过期过滤」",
        '可不做"过期过滤"',
    ]
    for phrase in forbidden:
        assert phrase not in t, f"PRD still contains forbidden: {phrase}"
    assert "剪贴板" in t
    assert "引擎" in t or "强制" in t or "有效期" in t
    # residual vector-as-main-path architecture diagram
    assert "向量存储" not in t, "PRD still has vector store as main architecture"
    assert "PostgreSQL" in t or "Postgres" in t


def test_current_portfolio_dashboard_keeps_architecture_redlines() -> None:
    """The current portfolio entry must not revive a Demo-only product contract."""
    path = DESIGN.parents[1] / "00-项目驾驶舱.md"
    assert path.is_file(), f"missing {path}"
    t = path.read_text(encoding="utf-8")
    for phrase in (
        "自动填优先",
        "自动填写优先",
        "演示可不做过期过滤",
        "可不做过期过滤",
    ):
        assert phrase not in t, f"current portfolio dashboard still contains forbidden: {phrase}"
    _assert_same_line(t, "剪贴板主 CTA", "autofill", "实验性次入口")
    _assert_same_line(t, "S0 合成 fixture", "有效窗口", "不得返回窗外话术")
    _assert_same_line(
        t,
        "兼容机器状态",
        "Ddev / 开发期",
        "架构设计 PASS-WITH-CONDITIONS",
        "实现设计文档 Ready",
        "开发中",
        "`DEV-M1 · COMPLETE`",
        "`W0`～`W5` 已收口",
        "`DEC-SEARCH-01=PASS-WITH-CONDITIONS`",
        "`G1A-E0 T1～T3=COMPLETE`",
        "T4 输入包=`BLOCKED`",
        "负责人承接合同落地与版本化新包准备",
    )

    ledger_path = DESIGN.parent / "02-G0责任与证据台账.md"
    assert ledger_path.is_file(), f"missing {ledger_path}"
    ledger = ledger_path.read_text(encoding="utf-8")
    _assert_same_line(ledger, "DEC-025", "历史建议", "已被 31/37", "剪贴板主 CTA")
    _assert_same_line(ledger, "DEC-029", "99-历史/2026-08-06-架构设计收口/28-自研vs中台WBS对照.md", "46-实现设计-开工包.md")
    _assert_same_line(ledger, "有效期字段", "2026-09-01～2026-09-30", "effective_to=2026-10-01", "到期未复核自动停用")
    _assert_same_line(
        ledger,
        "CR-004",
        "DEV-M1 已在纯合成 PostgreSQL 15 链路实现受控 search",
        "query / impression / adoption / escalation",
        "desktop、真实来源和真实 G1a 仍未接入",
    )
    _assert_same_line(
        ledger,
        "G0-12",
        "USR-OPS-OWNER-001",
        "**Pass**",
        "`EVD-G0-12-OPS-DEPLOYMENT-20260810`",
    )
    assert "## 8A. G0-12 部署与运维签发包（已签）" in ledger
    _assert_same_line(
        ledger,
        "状态",
        "APPROVED / SIGNED",
        "EVD-G0-12-OPS-DEPLOYMENT-20260810",
        "只关闭 G0-12 / Scope #13",
        "不授权 G0、Ddev、真实数据或 Pilot",
    )
    _assert_same_line(
        ledger,
        "已签方案基线",
        "未来受控测试 profile",
        "`single_host`",
        "1×API",
        "1×TypeScript worker",
        "PostgreSQL **15.18**",
        "`multi_instance`",
        "另行批准",
    )
    _assert_same_line(
        ledger,
        "| RPO / RTO |",
        "`RPO ≤ 24h / RTO ≤ 4h`",
        "真 PG 备份",
        "演练前只写“目标”",
    )
    assert "v3.84" in ledger
    _assert_same_line(
        ledger,
        "DEC-058",
        "单人开发开工门最小化",
        "14/14",
        "15/15",
        "项目 Owner 先签 G0",
        "不同证据 ID 签 `DEC-DDEV-01`",
    )
    _assert_same_line(ledger, "G0-08", "**Pass**", "EVD-G0-08-GREENFIELD-ISOLATION-20260810")
    _assert_same_line(ledger, "G0-10", "**Pass**", "EVD-G0-10-PRD-SCOPE-FREEZE-20260810")
    _assert_same_line(ledger, "G0-11", "**Pass**", "EVD-G0-11-SECURITY-BOUNDARY-20260810")
    _assert_same_line(ledger, "G0-14", "**Pass**", "EVD-G0-14-WBS-CAPACITY-20260813", "EVD-G0-07-FEE-PATH-20260813")
    _assert_same_line(ledger, "G0-15", "**Pass**", "EVD-G0-15-RUN-HANDOVER-20260812")
    _assert_same_line(ledger, "G0-06", "**Pass**", "EVD-CONTENT-GOVERNANCE-APPROVAL-20260809")
    _assert_same_line(
        ledger,
        "DEC-059",
        "G0 = PASS",
        "USR-TIANYUAN-001",
        "EVD-G0-SIGN-20260831",
        "DEC-DDEV-01",
    )
    footer = ledger.rstrip().splitlines()[-1]
    assert footer.startswith("*G0 责任与证据台账 v3.84 · 2026-09-05")
    assert footer.endswith("*")
    for token in (
        "Menokin",
        "14/14",
        "15/15",
        "DEV-M1 · COMPLETE",
        "`DEC-SEARCH-01=PASS-WITH-CONDITIONS`",
        "`T4 BLOCKED / RISK REVALIDATION REQUIRED · T5 ATTEMPTED / BLOCKED · NOT_EVALUATED`",
        "后置门",
    ):
        assert token in footer, f"ledger footer missing: {token}"
    scope = (DESIGN.parent / "03-Scope与验收.md").read_text(encoding="utf-8")
    assert "Scope 与验收 v4.43" in scope
    _assert_same_line(
        scope,
        "| 9 |",
        "[x]",
        "EVD-G0-09-AUTHORITY-SOURCES-20260830",
    )
    _assert_same_line(
        scope,
        "> **状态：**",
        "v4.43",
        "Menokin",
        "Scope 15/15",
        "G0 与 Ddev 已分别签发",
        "`DEV-M0`",
        "真实坐席",
        "生产 ACL 继续后移",
    )
    _assert_same_line(
        scope,
        "| 12 |",
        "USR-SECURITY-OWNER-001",
        "[x]",
        "EVD-G0-11-SECURITY-BOUNDARY-20260810",
    )
    _assert_same_line(
        scope,
        "| 13 |",
        "USR-OPS-OWNER-001",
        "[x]",
        "`EVD-G0-12-OPS-DEPLOYMENT-20260810`",
    )
    _assert_same_line(
        scope,
        "| 15 |",
        "[x]",
        "EVD-G0-14-WBS-CAPACITY-20260813",
        "EVD-G0-07-FEE-PATH-20260813",
        "EVD-G0-15-RUN-HANDOVER-20260812",
    )
    scope_footer = scope.rstrip().splitlines()[-1]
    for token in (
        "Scope 与验收 v4.43",
        "15/15",
        "EVD-G0-SIGN-20260831",
        "EVD-DDEV-AUTH-20260831",
        "只放行 `DEV-M0`",
    ):
        assert token in scope_footer, f"scope footer missing: {token}"

    schedule = (DESIGN.parent / "01-总排期与阶段门禁.md").read_text(encoding="utf-8")
    delivery = (DESIGN.parent / "05-全栈交付计划.md").read_text(encoding="utf-8")
    cost = (DESIGN.parent / "04-费用与成本控制.md").read_text(encoding="utf-8")
    assert "排期版本：** v3.39" in schedule
    _assert_same_line(schedule, "DEC-DDEV-01", "Ddev 生效当日", "才可进入", "DEV-M0")
    _assert_same_line(schedule, "证据等级", "EVD-G0-14-WBS-CAPACITY-20260813", "公司受控系统归档", "不单独使 G0-14 / Scope #15 Pass")
    _assert_same_line(schedule, "一期部署与交付目标", "2026-08-31", "内部目标，不是对外硬承诺")
    _assert_same_line(schedule, "二期目标启动", "2026-09-12", "另批")
    _assert_same_line(schedule, "| 三期 |", "TBD", "另行立项", "不得由一期结果自动启动")
    assert "G0-14 · 单人 FDE 可签 WBS 草案" in schedule
    assert "Ddev → DEV-M0 → M1 → M2 → M3 → M4 → G1a → Pilot Ready → 连续两周 Pilot → G1b / M4" in schedule
    assert "每周最多安排 **4 个净工程日**" in schedule
    assert "全栈交付计划 v2.26" in delivery
    _assert_same_line(delivery, "两个分域闭环", "G0 / Ddev 已 Pass", "合成开发已完成 `DEV-M0` 与 `DEV-M1`", "真实运行仍待后续门禁")
    assert "正式开发仍须 Ddev" not in delivery
    assert "G0-15 · 已批准的运行交接方案" in delivery
    assert "EVD-G0-15-RUN-HANDOVER-20260812" in delivery
    assert "真实告警接入、备份恢复、回退和试点演练属于 Ddev 后退出证据" in delivery
    assert "费用与成本控制 v3.13" in cost
    assert "费用路径未批" not in cost
    assert "费用路径和 cap 均未签发" not in cost
    assert "G0-07 / G0-14 仍需" not in cost
    _assert_same_line(
        cost,
        "当前事实",
        "B 路径",
        "新增付费 0",
        "2026-09-30",
        "EVD-G0-07-FEE-PATH-20260813",
        "DEC-054 / DEC-055",
        "不再补一份重复延期材料",
    )
    _assert_same_line(cost, "当前设备决定", "保持现状", "不做硬件升级", "现有 Mac", "Windows 10 x64", "后续云服务器")

    old_wbs = _read_history("28-自研vs中台WBS对照.md")
    assert "SUPERSEDED" in old_wbs
    assert "46-实现设计-开工包.md" in old_wbs
    _assert_same_line(old_wbs, "剪贴板主 CTA", "autofill 仅实验", "有效期强制")


def test_raci_is_the_single_13_role_intake_with_fixed_owner_projection() -> None:
    """The owner intake is one governed table, not parallel lists that can drift."""
    ledger = (DESIGN.parent / "02-G0责任与证据台账.md").read_text(encoding="utf-8")
    scope = (DESIGN.parent / "03-Scope与验收.md").read_text(encoding="utf-8")
    implementation = _read("46-实现设计-开工包.md")
    assert ledger.count("## 5. RACI 具名区") == 1
    raci = _between(ledger, "## 5. RACI 具名区", "### 5.1")
    table_lines = [
        line.strip()
        for line in raci.splitlines()
        if line.strip().startswith("|") and line.strip().endswith("|")
    ]
    header = [cell.strip() for cell in table_lines[0][1:-1].split("|")]
    assert header == [
        "角色",
        "人员代号",
        "代理人代号",
        "接受职责证据 ID",
        "状态",
        "生效日期",
        "固定职责",
        "职责分离",
    ]
    rows = [[cell.strip() for cell in line[1:-1].split("|")] for line in table_lines[2:]]
    assert len(rows) == 13
    by_role = {row[0]: row for row in rows}
    fixed_responsibilities = {
        "项目负责人": "项目边界、门禁、排期、资源、CR、Ddev 组织与停启；作为 Tech Owner 最终签发技术基线、OpenAPI、目录、迁移、容量与版本锁",
        "客服业务 Owner": "作为 Product Owner 决定业务 Scope、优先级、hit@3 / no-hit、指标与验收阈值、工单分析口径、话术优化待办三态、试点停启与业务升级",
        "内容 / 话术 Owner": "权威内容正确性、有效期、复核、发布、下架与回退",
        "预算责任人": "费用路径、预算 cap、0 支出、下次决策日与止损",
        "IT / 安全责任人": "PII、出域、RBAC、留存删除、DLP、日志与模型许可",
        "IT 服务 / 运维责任人": "环境、账号、部署、监控、备份恢复、RPO / RTO 与交接",
        "设计负责人": "用户流程、交互、可访问性与 Windows 桌面体验",
        "前端负责人": "Electron、飞书登录、UI、升级回退与客户端安全",
        "后端负责人": "API、Auth / RBAC、PostgreSQL 事务、worker、outbox 与审计",
        "AI / RAG 负责人": "检索、排序、评测、版本与外部模型 / 训练边界",
        "QA 负责人": "测试策略、回归、E2E、性能与独立质量门证据",
        "数据 / 内容接口人": "四域来源映射、字段、ACL、版本、质量与 EVD 交接",
        "业务验收人": "按冻结样本、阈值与 Scope 出具业务 Pass / Fail",
    }
    assert list(by_role) == list(fixed_responsibilities)
    for role, responsibility in fixed_responsibilities.items():
        assert by_role[role][6] == responsibility, f"{role} fixed responsibility drifted"
        assert by_role[role][7], f"{role} responsibility-separation contract is empty"
    assert by_role["内容 / 话术 Owner"][5] == "2026-08-09"
    assert sum(row[4] in {"已接受", "Pass"} for row in rows) == 13
    assert "EVD-CONTENT-OWNER-ACCEPT-20260809" in by_role["内容 / 话术 Owner"][3]
    assert "EVD-RACI-ACCEPTANCE-PACK-20260810" in by_role["内容 / 话术 Owner"][3]
    for role, row in by_role.items():
        if role != "内容 / 话术 Owner":
            assert row[3] == "EVD-RACI-ACCEPTANCE-PACK-20260810", f"{role} acceptance pack drifted"
    separated_codes = [
        code
        for role in ("项目负责人", "客服业务 Owner", "预算责任人", "IT / 安全责任人")
        for code in by_role[role][1:3]
    ]
    assert len(set(separated_codes)) == 8
    for row in rows:
        if row[4] in {"待填", "候选"}:
            assert row[5] == "", f"{row[0]} has an effective date before accepting responsibility"

    _assert_same_line(
        ledger,
        "Product→客服业务 Owner",
        "Tech→项目负责人",
        "Security→IT / 安全责任人",
        "Content→内容 / 话术 Owner",
        "QA→QA 负责人",
        "Ops→IT 服务 / 运维责任人",
        "Cost→预算责任人",
    )
    _assert_same_line(
        ledger,
        "七类 Owner 映射",
        "固定从 §5 唯一 RACI 表投影",
        "Product=客服业务 Owner",
        "Tech=项目负责人",
        "Security=IT / 安全责任人",
        "Content=内容 / 话术 Owner",
        "QA=QA 负责人",
        "Ops=IT 服务 / 运维责任人",
        "Cost=预算责任人",
        "不重复填写",
    )
    intake_header = "| 角色 | 人员代号 | 代理人代号 | 接受职责证据 ID | 状态 | 生效日期 | 固定职责 | 职责分离 |"
    assert sum(text.count(intake_header) for text in (ledger, scope, implementation)) == 1
    _assert_same_line(scope, "| 2 |", "[x]", "EVD-RACI-ACCEPTANCE-PACK-20260810")
    _assert_same_line(scope, "| 4 |", "[x]", "EVD-RACI-ACCEPTANCE-PACK-20260810")
    _assert_same_line(ledger, "外部责任包", "14/14 Pass")
    _assert_same_line(ledger, "Scope 检查", "15/15 Pass")
    _assert_same_line(ledger, "| Ddev |", "**2026-08-31**", "EVD-DDEV-AUTH-20260831")


def test_schema_postgres_first_and_invariants() -> None:
    t = _read("33-schema-v1-草案.sql")
    # Production dialect is PostgreSQL, not SQLite PRAGMA header
    head = "\n".join(t.splitlines()[:8])
    assert "PostgreSQL" in head or "postgresql" in head.lower()
    assert "PRAGMA" not in t, "PRAGMA is SQLite — production SoR must not use it"
    assert "CREATE VIRTUAL TABLE" not in t, "FTS5 virtual table is SQLite dialect"
    assert "pg_catalog.numnode(search_document)" not in t, (
        "PostgreSQL exposes numnode(tsquery), not numnode(tsvector); "
        "use length(tsvector) for the non-empty search-document invariant"
    )
    assert t.count("pg_catalog.length(search_document) > 0") == 2, (
        "staging and release search documents must both reject empty tsvector values"
    )
    for sql_expression in ("coalesce", "greatest"):
        assert f"pg_catalog.{sql_expression}(" not in t, (
            f"{sql_expression.upper()} is SQL expression syntax, not a schema-qualified function"
        )

    for entity in (
        "content_releases",
        "announcements",
        "import_batches",
        "staging_scripts",
        "release_items",
        "query_events",
        "scripts",
        "client_sync_state",
        "policy_flags",
        "app_users",
        "iteration_tasks",
        "iteration_task_status_audits",
        "work_order_import_batches",
        "work_order_records",
        "work_order_export_audits",
        "privacy_notices",
        "notice_decisions",
        "candidate_impressions",
        "adoption_events",
        "escalate_actions",
    ):
        assert entity in t, f"missing entity {entity}"

    # Immutable snapshot of answer at publish
    assert "answer_text" in t
    assert re.search(r"release_items", t)

    # Honesty CHECK: adopted requires successful push
    assert "adoption_adopted_requires_success" in t or (
        "outcome <> 'adopted'" in t and "clipboard" in t
    )

    # Effective-date view or equivalent
    assert "v_scripts_recommendable" in t or "effective_from" in t

    # Phase1 policy defaults
    assert "rewrite" in t.lower()
    assert "auto_send" in t.lower()


def test_api_contract_ports_and_state_machine() -> None:
    t = _read("39-API合同与发布状态机-v1.md")
    _assert_same_line(
        t,
        "DEC-042 边界",
        "schema v1.13",
        DEV_M1_SCHEMA_V1_13_SHA256,
        "OpenAPI 1.11.0",
        OPENAPI_SHA256,
    )
    for route in (
        "/v1/search",
        "/v1/events/adoption",
        "/v1/events/escalate",
        "/v1/notices/current",
        "/v1/notices/{version}/decision",
        "/v1/content/import",
        "/v1/content/publish",
        "/v1/announce/current",
        "/v1/announce/ack",
        "/v1/metrics/iteration-tasks",
        "/v1/events/iteration-tasks/{task_id}/start",
        "/v1/events/iteration-tasks/{task_id}/close",
        "/v1/work-orders/imports",
        "/v1/work-orders/imports/{import_batch_id}",
        "/v1/work-orders/analysis",
        "/v1/work-orders/records",
        "/v1/work-orders/analysis/export",
    ):
        assert route in t, f"missing route {route}"
    assert "staged" in t and "publishing" in t and "published" in t
    assert "INV-NR" in t or "字节" in t
    assert "INV-EFF" in t
    assert "INV-ADOPT" in t
    assert "Idempotency" in t or "幂等" in t
    # adopted honesty in API
    assert "clipboard" in t and "autofill" in t
    assert "POLICY_DENIED" in t or "adopted" in t


def test_openapi_is_machine_contract_and_matches_markdown_routes() -> None:
    markdown = _read("39-API合同与发布状态机-v1.md")
    spec = _read("openapi.v1.yaml")
    assert re.search(r"^openapi:\s+3\.1(?:\.\d+)?\s*$", spec, flags=re.M)
    assert re.search(rf"^\s*version:\s+{re.escape(OPENAPI_VERSION)}\s*$", spec, flags=re.M)
    assert "bearerAuth:" in spec and "mockUser:" in spec and "mockRole:" in spec
    assert "RequiredIdempotencyKey:" in spec and "Retry-After:" in spec
    assert "x-phase1-hard-off:" in spec and "rewrite" in spec and "auto_send" in spec
    assert not re.search(r"\$ref:\s*['\"]?https?://", spec), "machine contract must be self-contained/offline"

    markdown_ops = set(
        re.findall(
            r"^###\s+`?(GET|POST|PUT|PATCH|DELETE)\s+(/v1/[^\s`（]+)",
            markdown,
            flags=re.M,
        )
    )
    spec_ops = _openapi_operations(spec)
    assert markdown_ops, "no public API operations extracted from Markdown contract"
    assert spec_ops == markdown_ops, (
        f"OpenAPI/Markdown route drift: only_spec={sorted(spec_ops - markdown_ops)} "
        f"only_markdown={sorted(markdown_ops - spec_ops)}"
    )

    path_starts = list(re.finditer(r"^  (/v1/[^:]+):\s*$", spec, flags=re.M))
    for index, match in enumerate(path_starts):
        end = path_starts[index + 1].start() if index + 1 < len(path_starts) else spec.find("\ncomponents:", match.start())
        block = spec[match.start() : end]
        assert "'503':" in block, f"DB/backpressure route missing explicit 503: {match.group(1)}"

    for platform_path, response_schema in (("/health", "HealthResponse"), ("/ready", "ReadyResponse")):
        platform = _between(spec, f"  {platform_path}:", "\n  /" if platform_path == "/health" else "\n  /v1/")
        assert "security: []" in platform and response_schema in platform
    assert "NotReadyResponse" in spec and "Retry-After:" in _between(spec, "  /ready:", "\n  /v1/")
    ready_checks = _between(spec, "    ReadyChecks:", "    ReadyResponse:")
    assert "required: [database, schema, auth, storage, content]" in ready_checks
    assert "storage:" in ready_checks
    not_ready = _between(spec, "    NotReadyResponse:", "    ValidationErrorEnvelope:")
    assert "anyOf:" in not_ready and "storage: { const: not_ready }" in not_ready
    import_error = _between(spec, "    ImportErrorReport:", "    ImportPreviewItem:")
    assert "additionalProperties: false" in import_error
    assert "required: [code, diagnostic_id]" in import_error
    assert "pattern: '^diag_[0-9a-f]{32}$'" in import_error
    issue_schema = _between(import_error, "    ImportIssueCode:")
    openapi_issue_codes = set(re.findall(r"^\s+- ([A-Z][A-Z0-9_]+)\s*$", issue_schema, flags=re.M))
    assert openapi_issue_codes == IMPORT_ISSUE_CODES
    assert "maxItems: 26" in import_error and "uniqueItems: true" in import_error
    assert "pattern: '^[A-Z][A-Z0-9_]{0,63}$'" not in import_error
    for forbidden_public_field in ("last_error:", "stack:", "path:", "token:"):
        assert forbidden_public_field not in import_error
    service_unavailable = _between(spec, "    ServiceUnavailable:", "    InternalError:")
    assert "oneOf:" in service_unavailable
    assert "OverloadedErrorEnvelope" in service_unavailable
    assert "ContentNotReadyErrorEnvelope" in service_unavailable
    for route_start, route_end in (
        ("  /v1/search:", "  /v1/events/adoption:"),
        ("  /v1/announce/current:", "  /v1/announce/snapshot:"),
    ):
        assert "#/components/responses/ServiceUnavailable" in _between(spec, route_start, route_end)
    for code in (
        "VALIDATION",
        "UNAUTHORIZED",
        "FORBIDDEN",
        "NOT_FOUND",
        "CONFLICT",
        "RATE_LIMITED",
        "OVERLOADED",
        "INTERNAL",
    ):
        assert f"const: {code}" in spec, f"status-specific error schema missing const {code}"
    assert "reason: { const: CONTENT_NOT_READY }" in spec
    import_status = _between(spec, "    ImportStatusResponse:", "    CancelImportRequest:")
    assert "oneOf:" in import_status and "const: failed" in import_status
    assert "#/components/schemas/ImportFailureReport" in import_status
    assert "enum: [validating, staged, publishing, published, rolled_back]" in import_status
    assert "type: 'null'" in import_status
    import_status_enum = _between(spec, "    ImportStatus:", "    ImportOperation:")
    assert "enum: [validating, failed, staged, publishing, published, rolled_back]" in import_status_enum
    assert "旧数据只读兼容值" in import_status_enum

    for response_code in ("'400':", "'401':", "'403':", "'409':", "'429':", "'500':", "'503':"):
        assert response_code in spec
    publish = _between(spec, "  /v1/content/publish:", "  /v1/content/rollback:")
    assert "'404':" in publish and "#/components/responses/NotFound" in publish
    search_schema = _between(spec, "    SearchRequest:", "    HitStatus:")
    assert "maxLength: 500" in search_schema and "maxLength: 128" in search_schema
    assert "x-http-json-body-max-bytes: 32768" in spec
    metrics = _between(spec, "  /v1/metrics/tool:", "  /v1/metrics/stream:")
    assert "x-time-window-max-days: 7" in metrics and "otherwise 400 VALIDATION" in metrics
    assert "不得再将本文声称为“等价 OpenAPI”" in markdown
    assert "openapi.v1.yaml" in markdown


def test_cr_002_search_copy_machine_contract_invariants() -> None:
    """CR-002 records automatic facts; review labels stay in versioned offline EVD."""
    raw_ddl = _read("33-schema-v1-草案.sql")
    ddl = _strip_sql_comments(raw_ddl)
    contract = _read("39-API合同与发布状态机-v1.md")
    spec = _read("openapi.v1.yaml")
    model = _read("26-话术库与自动事实数据模型.md")

    _assert_same_line(model, "`source_ref`", "| 是 |", "发布血缘投影", "导入文件行不得自报")
    _assert_same_line(model, "`review_due_at`", "| 是 |", "下次内容复核时间")
    _assert_same_line(model, "`effective_from`", "| 是 |", "生效时间", "禁止空值放行")
    _assert_same_line(model, "`effective_to`", "| 否 |", "空=无预定失效", "过期不得进 Top3")

    query_table = _between(
        ddl,
        "CREATE TABLE IF NOT EXISTS query_events (",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_query_user",
    )
    for field in (
        "parent_query_id",
        "interaction_reason",
        "text_storage_status",
        "collection_mode",
        "detected_platform",
        "platform_source",
        "redaction_policy_version",
        "text_expires_at",
        "event_expires_at",
    ):
        assert field in query_table, f"CR-002 query event missing {field}"
    assert "interaction_reason IN ('original','reselection')" in query_table
    assert "interaction_reason = 'original' AND parent_query_id IS NULL" in query_table
    assert "interaction_reason = 'reselection' AND parent_query_id IS NOT NULL" in query_table
    assert "collection_mode IN ('synthetic','approved_redacted','pilot_recorded')" in query_table
    assert "platform_source IN ('manual','foreground_process','native_integration','unknown')" in query_table
    assert "query_platform_provenance_shape" in query_table
    assert "detected_platform IS NOT NULL" in query_table
    assert "platform IS NOT NULL" in query_table
    assert "platform = detected_platform" in query_table
    assert "text_storage_status IN ('stored','suppressed')" in query_table
    assert "query_text_redacted TEXT NOT NULL" not in query_table
    assert "query_text_hash     TEXT NOT NULL" not in query_table
    assert "text_storage_status = 'stored'" in query_table
    assert "query_text_redacted IS NOT NULL" in query_table
    assert "query_text_hash IS NOT NULL" in query_table
    assert "text_storage_status = 'suppressed'" in query_table
    assert "query_text_redacted IS NULL" in query_table
    assert "query_text_hash IS NULL" in query_table

    lineage_guard = _sql_function(ddl, "trg_query_lineage_guard")
    for invariant in (
        "query lineage is append-only",
        "original query cannot have parent_query_id",
        "reselection requires a different parent query",
        "parent query belongs to another user",
        "parent query is not terminal",
        "query lineage cycle detected",
    ):
        assert invariant in lineage_guard

    candidate_table = _between(
        ddl,
        "CREATE TABLE IF NOT EXISTS candidate_impressions (",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_candidate_query_rank_script",
    )
    for field in ("release_id", "script_id", "script_version", "content_hash"):
        assert field in candidate_table, f"CR-002 candidate provenance missing {field}"
    assert "candidate_release_item_provenance_fk" in ddl
    assert "FOREIGN KEY (release_id, script_id, script_version, content_hash)" in ddl
    assert "REFERENCES release_items(release_id, script_id, script_version, content_hash)" in ddl

    adoption_table = _between(
        ddl,
        "CREATE TABLE IF NOT EXISTS adoption_events (",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_adoption_copy_provenance",
    )
    assert "push_method" in adoption_table
    assert "outcome IN ('adopted','dismissed','no_hit_exit','timeout')" in adoption_table
    assert "'clipboard','autofill','failed','pending'" in adoption_table
    assert "outcome = 'adopted'" in adoption_table
    assert "push_method IN ('clipboard','autofill')" in adoption_table

    assert "CREATE TABLE IF NOT EXISTS usage_outcome_events" not in ddl
    escalation_table = _between(
        ddl,
        "CREATE TABLE IF NOT EXISTS escalate_actions (",
        "CREATE OR REPLACE FUNCTION trg_query_lineage_guard",
    )
    assert "action IN ('open_feishu','copy_contact','other')" in escalation_table
    assert "UNIQUE (query_id, action)" in escalation_table
    assert "escalate_query_owner_fk" in ddl
    assert "FOREIGN KEY (query_id, user_id) REFERENCES query_events(query_id, user_id)" in ddl

    notices = _between(
        ddl,
        "CREATE TABLE IF NOT EXISTS privacy_notices (",
        "CREATE TABLE IF NOT EXISTS scripts (",
    )
    assert "status IN ('draft','current','retired')" in notices
    assert "CREATE UNIQUE INDEX IF NOT EXISTS uq_privacy_notice_current" in notices
    assert "CREATE TABLE IF NOT EXISTS notice_decisions" in notices
    assert "PRIMARY KEY (notice_version, user_id)" in notices
    assert "decision IN ('accepted','declined')" in notices

    for table_start, table_end in (
        ("CREATE TABLE IF NOT EXISTS scripts (", "CREATE TABLE IF NOT EXISTS script_questions ("),
        ("CREATE TABLE IF NOT EXISTS staging_scripts (", "CREATE INDEX IF NOT EXISTS idx_staging_batch"),
        ("CREATE TABLE IF NOT EXISTS release_items (", "CREATE INDEX IF NOT EXISTS idx_release_items_search_document"),
    ):
        table = _between(ddl, table_start, table_end)
        for field in ("source_ref", "owner_role", "review_due_at"):
            assert field in table, f"{table_start} missing {field}"
    staging = _between(
        ddl,
        "CREATE TABLE IF NOT EXISTS staging_scripts (",
        "CREATE INDEX IF NOT EXISTS idx_staging_batch",
    )
    assert "operation = 'withdraw'" in staging
    _assert_same_line(staging, "owner_role IS NULL", "review_due_at IS NULL")
    assert "source_ref       TEXT NOT NULL" in staging
    assert "source_version_id TEXT NOT NULL" in staging
    for function_name in ("publish_content_release", "rollback_content_release"):
        function = _sql_function(ddl, function_name)
        for field in ("source_ref", "owner_role", "review_due_at"):
            assert field in function, f"{function_name} does not preserve {field}"

    search_request = _between(spec, "    SearchRequest:", "    HitStatus:")
    for field in (
        "parent_query_id",
        "interaction_reason",
        "collection_mode",
        "detected_platform",
        "platform",
        "platform_source",
    ):
        assert field in search_request
    assert "title: original 根问题" in search_request
    assert "title: reselection 后续操作" in search_request
    assert "const: original" in search_request and "const: reselection" in search_request
    assert "pilot_recorded" in spec and "current notice" in spec
    assert "enum: [qianniu, douyin, unknown, null]" in spec
    assert "enum: [manual, foreground_process, native_integration, unknown]" in spec

    candidate = _between(spec, "    SearchCandidate:", "    TelemetryStatus:")
    for field in (
        "release_id",
        "script_version",
        "content_hash",
        "effective_from",
        "effective_to",
    ):
        assert field in candidate
    assert "additionalProperties: false" in candidate
    for forbidden_public_field in (
        "source_ref:",
        "source_version_id:",
        "owner_role:",
        "review_due_at:",
        "primary_reviewer_id:",
        "secondary_reviewer_id:",
        "primary_review_evd:",
        "secondary_review_evd:",
    ):
        assert forbidden_public_field not in candidate
    assert "enum: [recorded, collection_disabled]" in spec
    assert "不写 query/impression/event" in spec
    assert "客户端不得随后提交 adoption/escalate" in spec

    terminal = _between(spec, "    AdoptionOutcome:", "    PushMethod:")
    assert "enum: [adopted, dismissed, no_hit_exit, timeout]" in terminal
    assert "CLIENT_ACTION_TIMEOUT_MS" in terminal
    assert "不表示已发送、正确或客户已接受" in terminal

    for schema_start, schema_end in (
        ("    AdoptedEventRequest:", "    NonAdoptedEventRequest:"),
        ("    NonAdoptedEventRequest:", "    AdoptionEventResponse:"),
        ("    EscalationRequest:", "    EscalationResponse:"),
    ):
        request_schema = _between(spec, schema_start, schema_end)
        assert "type: object" in request_schema
        assert "additionalProperties: false" in request_schema, (
            f"public request schema must reject unknown/sensitive fields: {schema_start.strip()}"
        )

    for route in (
        "/v1/events/escalate",
        "/v1/notices/current",
        "/v1/notices/{version}/decision",
    ):
        assert route in contract and route in spec
    assert "CR-002" in contract and "不是聊天记录" in contract
    assert "一期 OpenAPI **不得**出现人工复核、dataset、teacher、training、distillation" in contract
    assert "collection_disabled" in contract
    assert "query/impression/adoption/escalate 零写入" in contract
    assert "DLP/Auth/content 任一失败不得走此降级" in contract
    escalate_route = _between(spec, "  /v1/events/escalate:", "  /v1/metrics/tool:")
    assert "#/components/parameters/RequiredIdempotencyKey" in escalate_route
    assert "不结束 query" in escalate_route and "不证明外部人工已接单或问题已解决" in escalate_route

    for forbidden in (
        "usage_outcome",
        "usage-outcome",
        "self_report_coverage",
        "self_reported_send_rate",
        "major_edit_rate",
        "client_self_report",
        "server_default",
    ):
        assert forbidden not in ddl.lower(), f"schema retains deprecated online outcome contract: {forbidden}"
        assert forbidden not in spec.lower(), f"OpenAPI retains deprecated online outcome contract: {forbidden}"
        assert forbidden not in contract.lower(), f"Markdown retains deprecated online outcome contract: {forbidden}"

    metrics_schema = _between(spec, "    ToolMetricsResponse:", "    MetricCandidate:")
    for field in (
        "root_question_count",
        "search_operation_count",
        "reselection_count",
        "root_adopted_count",
        "operation_adopted_count",
        "root_adoption_rate",
        "operation_adoption_rate",
        "operation_no_hit_count",
        "operation_no_hit_rate",
        "top1_copy_share",
        "root_escalated_count",
        "escalate_action_count",
        "root_escalation_rate",
        "p95_latency_ms",
    ):
        assert field in metrics_schema, f"CR-002 metrics read model missing {field}"
    assert "不代表已发送或正确" in metrics_schema
    assert "非解决率" in metrics_schema

    stream_route = _between(spec, "  /v1/metrics/stream:", "  /v1/metrics/iteration-tasks:")
    for parameter in (
        "MetricsFrom",
        "MetricsTo",
        "MetricsUserId",
        "MetricsPlatform",
        "MetricsHitStatus",
        "MetricsChosenRank",
        "MetricsReleaseId",
        "StreamLimit",
        "MetricsCursor",
    ):
        assert f"#/components/parameters/{parameter}" in stream_route
    stream_item = _between(spec, "    MetricsStreamItem:", "    MetricsStreamResponse:")
    for field in (
        "root_query_id",
        "parent_query_id",
        "interaction_reason",
        "query_text_redacted",
        "text_storage_status",
        "platform",
        "platform_source",
        "chosen_rank",
        "push_method",
        "outcome",
        "release_id",
        "latency_ms",
        "escalate_actions",
        "candidates",
    ):
        assert f"{field}:" in stream_item, f"CR-002 stream read model missing {field}"
    metric_candidate = _between(spec, "    MetricCandidate:", "    MetricsStreamItem:")
    for field in (
        "script_version",
        "content_hash",
        "source_ref",
        "effective_from",
        "effective_to",
        "review_due_at",
    ):
        assert f"{field}:" in metric_candidate, f"CR-002 stream candidate missing {field}"
    assert "review_usage_sample" not in spec
    change = _read("47-CR-002搜索复制证据闭环.md")
    test_plan = _read("48-CR-002测试计划.md")
    training_test_plan = _read("50-CR-003测试计划.md")
    _assert_same_line(test_plan, "日期", "2026-08-10", "v0.5")
    _assert_same_line(training_test_plan, "日期", "2026-08-10", "v0.4")
    assert "修改程度" in change and "是否发送" in change and "正确性" in change
    assert "当前 OpenAPI 不存在人工复核队列或结论写入 API" in change
    assert "修改/发送/正确性三个维度独立" in test_plan
    assert "当前 OpenAPI 无复核队列 API" in test_plan
    for cr003_guard in (
        "49 / 50",
        "0 / 14 / 30",
        "semantic promotion",
        "DeepSeek",
        "GLM 当前明确禁止用于蒸馏",
        "real / policy / synthetic",
        "additionalProperties:false",
        "Embedding 离线影子",
        "本地 student",
        "train/G1a/G1b",
        "teacher run",
        "预算 cap",
    ):
        assert cr003_guard in change, f"CR-003 reservation missing: {cr003_guard}"
    assert "train/G1a/G1b 泄漏扫描" in test_plan
    assert "strict JSON 抗注入" in test_plan
    assert "teacher 预算越限" in test_plan
    scope = (DESIGN.parent / "03-Scope与验收.md").read_text(encoding="utf-8")
    _assert_same_line(scope, "自动事实", "不再要求强制八枚举自报", "usage_outcome")
    _assert_same_line(scope, "离线三维样本", "不从复制行为自动推断")


def test_cr_004_authoritative_source_fail_closed_contract_is_static_and_complete() -> None:
    """CR-004 must be fail-closed end to end without pretending runtime evidence exists."""
    raw_ddl = _read("33-schema-v1-草案.sql")
    ddl = _strip_sql_comments(raw_ddl)
    spec = _read("openapi.v1.yaml")
    ledger = (DESIGN.parent / "02-G0责任与证据台账.md").read_text(encoding="utf-8")
    scope = (DESIGN.parent / "03-Scope与验收.md").read_text(encoding="utf-8")
    model = _read("26-话术库与自动事实数据模型.md")
    dashboard = _read("29-Dashboard产品说明.md")
    product = _read("31-产品契约-v1.md")
    ssot = _read("37-架构SSOT-v1.md")
    contract = _read("39-API合同与发布状态机-v1.md")
    nfr = _read("41-NFR扩展并发与防改崩.md")
    implementation = _read("46-实现设计-开工包.md")

    # One frozen version lineage; DEC-042 extends the same static-only implementation boundary.
    assert "DESIGN ALIGNED · PENDING G0 / Ddev" in model
    assert "**v1.11-dec042**" in model
    assert "**v1.3-cr004**" in dashboard
    assert "产品契约 v1.6" in product
    assert "当前 v1.16" in ssot
    assert "**v1.16 ENG-T1" in contract
    assert "NFR 冻结包 v1.13" in nfr
    assert "2026-08-30 · v1.22" in implementation
    assert SCHEMA_VERSION in raw_ddl
    assert f"version: {OPENAPI_VERSION}" in spec
    for name, text in {
        "26": model,
        "29": dashboard,
        "31": product,
        "37": ssot,
        "39": contract,
        "41": nfr,
        "46": implementation,
    }.items():
        assert "CR-004" in text, f"{name} must preserve the CR-004 boundary"
        assert "未实现" in text or ("运行" in text and "待" in text), (
            f"{name} must preserve the static-only CR-004 boundary"
        )

    # Source versions and suspensions are append-only evidence; restoring requires a new version.
    source_versions = _between(
        ddl,
        "CREATE TABLE IF NOT EXISTS authoritative_source_versions (",
        "CREATE TABLE IF NOT EXISTS authoritative_source_suspensions (",
    )
    for field in ("source_version_id", "source_ref", "domain", "upstream_version", "snapshot_sha256", "use_class", "approval_evd"):
        assert field in source_versions
    assert "('presale','campaign','aftersale','product')" in source_versions
    assert "('canonical','reference')" in source_versions
    assert not re.search(r"\b(?:is_current|current_status)\b", source_versions)
    for trigger in (
        "authoritative_source_versions_immutable",
        "authoritative_source_suspensions_immutable",
        "import_batch_source_bindings_immutable",
        "source_denial_audits_immutable",
        "snapshot_offline_leases_immutable",
    ):
        assert trigger in ddl, f"missing immutable CR-004 trigger {trigger}"
    assert "reinstate_authoritative_source" not in ddl.lower()
    assert "resume_authoritative_source" not in ddl.lower()
    suspend = _sql_function(ddl, "suspend_authoritative_source")
    for phrase in ("p_actor_role IS DISTINCT FROM 'owner'", "pg_try_advisory_xact_lock", "INSERT INTO public.authoritative_source_suspensions"):
        assert phrase in suspend

    # Every release carries exactly one immutable binding for all four domains and a verified set hash.
    release_bindings = _between(
        ddl,
        "CREATE TABLE IF NOT EXISTS release_source_bindings (",
        "CREATE TABLE IF NOT EXISTS release_items (",
    )
    assert "PRIMARY KEY (release_id, domain)" in release_bindings
    assert "('presale','campaign','aftersale','product')" in release_bindings
    release_complete = _sql_function(ddl, "trg_release_source_set_complete")
    for phrase in ("v_count <> 4", "use_class <> 'canonical'", "SOURCE_SUSPENDED", "SOURCE_BINDING_HASH_MISMATCH"):
        assert phrase in release_complete
    assert "DEFERRABLE INITIALLY DEFERRED" in ddl

    # Import, publish, rollback and search all consume the server-owned source set and fail closed.
    enqueue = _sql_function(ddl, "enqueue_content_import")
    publish = _sql_function(ddl, "publish_content_release")
    rollback = _sql_function(ddl, "rollback_content_release")
    for phrase in ("p_source_bindings JSONB", "authoritative_source_versions", "use_class <> 'canonical'", "SOURCE_SUSPENDED"):
        assert phrase in enqueue
    for phrase in ("v_source_count <> 4", "v_source_noncanonical", "v_source_suspended", "SOURCE_BINDING_HASH_MISMATCH", "INSERT INTO public.release_source_bindings"):
        assert phrase in publish
    for phrase in ("v_source_count <> 4", "v_source_noncanonical", "v_source_suspended", "SOURCE_BINDING_HASH_MISMATCH", "INSERT INTO public.release_source_bindings"):
        assert phrase in rollback
    for phrase in (
        "CREATE OR REPLACE VIEW v_release_source_gate AS",
        "CREATE OR REPLACE VIEW v_scripts_recommendable AS",
        "gate.source_gate_ready",
        "query_source_gate_telemetry_guard",
        "impression_source_gate_telemetry_guard",
        "SOURCE_GATE_NOT_READY",
    ):
        assert phrase in ddl
    search_route = _between(spec, "  /v1/search:", "  /v1/events/adoption:")
    assert "x-source-denial-audit-required: true" in search_route
    assert "SOURCE_GATE_NOT_READY" in search_route and "零写入" in search_route
    for route_start, route_end in (
        ("  /v1/content/import:", "  /v1/content/import/{import_batch_id}:"),
        ("  /v1/content/publish:", "  /v1/content/rollback:"),
        ("  /v1/content/rollback:", "  /v1/announce/current:"),
    ):
        route = _between(spec, route_start, route_end)
        assert "x-source-denial-audit-required: true" in route
        assert "SOURCE_" in route

    # A denial audit survives the rejected business rollback, contains safe identifiers only, and is idempotent.
    denial_table = _between(
        ddl,
        "CREATE TABLE IF NOT EXISTS source_denial_audits (",
        "CREATE TABLE IF NOT EXISTS client_sync_state (",
    )
    for field in ("denial_key", "operation", "reason_code", "actor_subject_hash", "hash_key_version", "diagnostic_id"):
        assert field in denial_table
    for forbidden in ("query_text", "internal_url", "stack_trace"):
        assert forbidden not in denial_table
    assert "'announce_ack'" in denial_table
    denial_fn = _sql_function(ddl, "record_source_denial_audit")
    assert "ON CONFLICT (denial_key) DO NOTHING" in denial_fn
    assert "IDEMPOTENCY_BODY_MISMATCH" in denial_fn
    assert "'announce_ack'" in denial_fn
    denial_contract = _between(spec, "  x-source-denial-audit:", "  x-offline-snapshot-lease:")
    for phrase in ("transaction: independent-after-rollback", "commitBeforeHttpResponse: true", "forbiddenFields", "record_source_denial_audit"):
        assert phrase in denial_contract

    # The shared writer is private. Workload wrappers expose disjoint operation allowlists,
    # and every public endpoint must point at the wrapper for its own workload role.
    runtime_denial_fn = _sql_function(ddl, "record_runtime_source_denial_audit")
    admin_denial_fn = _sql_function(ddl, "record_admin_source_denial_audit")
    assert "p_operation NOT IN ('content_import','search','announce_current','announce_snapshot','announce_ack')" in runtime_denial_fn
    assert "p_operation NOT IN ('content_publish','content_rollback','source_suspend')" in admin_denial_fn
    assert "RETURN public.record_source_denial_audit(" in runtime_denial_fn
    assert "RETURN public.record_source_denial_audit(" in admin_denial_fn

    acl = _between(ddl, "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;", "COMMIT;")
    app_roles = r"(?:app_runtime|app_content_admin|app_import_worker|app_work_order_worker)"
    assert not re.search(
        rf"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.record_source_denial_audit\s*\([^;]*\)\s+TO\s+{app_roles}",
        acl,
        flags=re.I | re.S,
    ), "core source-denial writer must not be granted to an application role"
    assert re.search(
        r"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.record_runtime_source_denial_audit\s*\([^;]*\)\s+TO\s+app_runtime",
        acl,
        flags=re.I | re.S,
    )
    assert not re.search(
        r"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.record_runtime_source_denial_audit\s*\([^;]*\)\s+TO\s+(?:app_content_admin|app_import_worker|app_work_order_worker)",
        acl,
        flags=re.I | re.S,
    )
    assert re.search(
        r"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.record_admin_source_denial_audit\s*\([^;]*\)\s+TO\s+app_content_admin",
        acl,
        flags=re.I | re.S,
    )
    assert not re.search(
        r"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.record_admin_source_denial_audit\s*\([^;]*\)\s+TO\s+(?:app_runtime|app_import_worker|app_work_order_worker)",
        acl,
        flags=re.I | re.S,
    )

    for route_start, route_end, operation in (
        ("  /v1/search:", "  /v1/events/adoption:", "search"),
        ("  /v1/content/import:", "  /v1/content/import/{import_batch_id}:", "content_import"),
        ("  /v1/announce/current:", "  /v1/announce/snapshot:", "announce_current"),
        ("  /v1/announce/snapshot:", "  /v1/announce/ack:", "announce_snapshot"),
        ("  /v1/announce/ack:", "  /v1/policy:", "announce_ack"),
    ):
        route = _between(spec, route_start, route_end)
        assert f"operation: {operation}" in route
        assert "function: record_runtime_source_denial_audit" in route
        assert "function: record_admin_source_denial_audit" not in route
        assert "function: record_source_denial_audit" not in route
    for route_start, route_end, operation in (
        ("  /v1/content/publish:", "  /v1/content/rollback:", "content_publish"),
        ("  /v1/content/rollback:", "  /v1/announce/current:", "content_rollback"),
    ):
        route = _between(spec, route_start, route_end)
        assert f"operation: {operation}" in route
        assert "function: record_admin_source_denial_audit" in route
        assert "function: record_runtime_source_denial_audit" not in route
        assert "function: record_source_denial_audit" not in route

    # Offline use is a short immutable lease bound to client/user/release/source hash; ACK validates but never renews it.
    lease_table = _between(
        ddl,
        "CREATE TABLE IF NOT EXISTS snapshot_offline_leases (",
        "CREATE TABLE IF NOT EXISTS source_denial_audits (",
    )
    for field in ("lease_token_hash", "client_id", "user_id", "release_id", "source_binding_hash", "issued_at", "expires_at"):
        assert field in lease_table
    issue_lease = _sql_function(ddl, "issue_snapshot_offline_lease")
    validate_lease = _sql_function(ddl, "validate_snapshot_offline_lease")
    assert "p_ttl_seconds INTEGER DEFAULT 600" in issue_lease
    assert "p_ttl_seconds < 60 OR p_ttl_seconds > 900" in issue_lease
    for reason in ("OFFLINE_LEASE_INVALID", "OFFLINE_LEASE_EXPIRED", "OFFLINE_LEASE_BINDING_MISMATCH", "SOURCE_GATE_NOT_READY"):
        assert reason in validate_lease
    ack = _sql_function(ddl, "ack_client_release")
    assert "p_offline_lease_token TEXT" in ack and "validate_snapshot_offline_lease" in ack
    assert "UPDATE public.snapshot_offline_leases" not in ack
    current_reader = _sql_function(ddl, "read_current_announcement_with_lease")
    snapshot_reader = _sql_function(ddl, "read_snapshot_page")
    for phrase in ("SECURITY DEFINER", "issue_snapshot_offline_lease", "announcement_title"):
        assert phrase in current_reader
    for phrase in (
        "SECURITY DEFINER",
        "validate_snapshot_offline_lease",
        "LIMIT p_limit + 1",
        "public.content_public_questions(page.questions_json)",
        "'effective_from', page.effective_from",
        "'effective_to', page.effective_to",
    ):
        assert phrase in snapshot_reader
    for forbidden_internal_projection in (
        "source_version_id",
        "source_ref",
        "owner_role",
        "review_due_at",
        "primary_review_evd",
        "secondary_review_evd",
    ):
        assert forbidden_internal_projection not in snapshot_reader
    lease_contract = _between(spec, "  x-offline-snapshot-lease:", "  x-http-json-body-max-bytes:")
    for phrase in ("default: 600", "minimum: 60", "maximum: 900", "source_binding_hash", "ackRenewsLease: false"):
        assert phrase in lease_contract
    ack_schema = _between(spec, "    AnnouncementAckRequest:", "    OkResponse:")
    assert "required: [client_id, release_id, release_seq, offline_lease_token]" in ack_schema
    current_route = _between(spec, "  /v1/announce/current:", "  /v1/announce/snapshot:")
    snapshot_route = _between(spec, "  /v1/announce/snapshot:", "  /v1/announce/ack:")
    ack_route = _between(spec, "  /v1/announce/ack:", "  /v1/policy:")
    for phrase in ("read_current_announcement_with_lease", "app_runtime 不得直接读取", "source_binding_hash", "offline_lease"):
        assert phrase in current_route
    for phrase in (
        "read_snapshot_page",
        "app_runtime 不得直接读取 release_items",
        "SnapshotResponse",
        "SnapshotItem",
        "PublicSnapshotQuestion",
        "禁止 spread DB row",
    ):
        assert phrase in snapshot_route
    for forbidden_internal_projection in ("source_version_id", "source_ref", "review_due_at"):
        assert forbidden_internal_projection not in snapshot_route
    assert "ack_client_release(client_id,user_id,release_id,release_seq," in ack_route
    assert "offline_lease_token)" in ack_route
    for phrase in (
        "operation: announce_ack",
        "storage: source_denial_audits",
        "function: record_runtime_source_denial_audit",
        "source-denial-audits-write: required",
        "x-source-denial-audit-required: true",
    ):
        assert phrase in ack_route
    announce_contract = _between(contract, "## 6. Port: `announce` + 客户端同步", "## 7. Port: `policy` / `redaction`")
    for phrase in (
        "read_current_announcement_with_lease(client_id,user_id,ttl_seconds)",
        "read_snapshot_page(offline_lease_token,client_id,user_id,release_id,cursor,limit)",
        '"source_binding_hash": "64-char-hex"',
        '"offline_lease_token"',
        "ack_client_release(client_id,user_id,release_id,release_seq,offline_lease_token)",
    ):
        assert phrase in announce_contract
    snapshot_contract = _between(
        announce_contract,
        "### `GET /v1/announce/snapshot`",
        "### `POST /v1/announce/ack`",
    )
    for forbidden_internal_projection in (
        '"source_version_id"',
        '"source_ref"',
        '"review_due_at"',
        '"owner_role"',
        '"primary_review_evd"',
        '"secondary_review_evd"',
    ):
        assert forbidden_internal_projection not in snapshot_contract

    # G0-09 governance evidence is closed; runtime claims remain unimplemented and separately gated.
    assert "v3.84" in ledger and "DEC-041" in ledger and "CR-004" in ledger and "DEC-053" in ledger and "DEC-057" in ledger and "DEC-058" in ledger and "DEC-059" in ledger and "DEC-062" in ledger and "DEC-063" in ledger and "DEC-066" in ledger and "DEC-069" in ledger and "DEC-070" in ledger and "DEC-071" in ledger and "DEC-072" in ledger and "DEC-073" in ledger and "DEC-SEARCH-01" in ledger
    cr004_history_line = next(line for line in ledger.splitlines() if line.startswith("| 2026-08-09 | CR-004 |"))
    assert "W4" not in cr004_history_line and "DEC-066" not in cr004_history_line
    assert "运行能力尚未实现" in cr004_history_line and "DEC-039" in cr004_history_line
    g009_line = next(line for line in ledger.splitlines() if line.startswith("| G0-09 |"))
    for token in (
        "**Pass**",
        "EVD-G0-09-AUTHORITY-SOURCES-20260830",
    ):
        assert token in g009_line, f"G0-09 当前行缺少：{token}"
    _assert_same_line(ledger, "外部责任包", "14/14 Pass")
    _assert_same_line(ledger, "Scope 检查", "15/15 Pass")
    _assert_same_line(ledger, "| Ddev |", "**2026-08-31**", "EVD-DDEV-AUTH-20260831")
    _assert_same_line(
        ledger,
        "售前 `presale`",
        "SRC-92847D5B505F17C4",
        "canonical / current",
        "srcv_52af2c0a648a7f8c",
        "81 / 79 / 2",
        "EVD-G0-09-WORKBOOK-CLOSURE-20260830",
    )
    _assert_same_line(ledger, "活动 `campaign`", "SRC-92847D5B505F17C4", "canonical / current", "storewide + []", "仅 4 条", "2026-09-01～2026-09-30", "4 / 4 / 0")
    _assert_same_line(ledger, "产品 `product`", "SRC-92847D5B505F17C4", "canonical / current", "首列“适用产品”", "106 / 106 / 0")
    receipt = _between(
        ledger,
        "### G0-09 机器可核验关闭收据（公开安全投影）",
        "`2026-08-28` 活动候选的",
    )
    receipt_lines = receipt.splitlines()
    receipt_header = "| domain | source_ref | source_version_id | snapshot_evd | acl_evd | total_rows | importable_rows | quarantined_rows | quality_evd | final_approver_role | overall_approval_evd | readiness |"
    assert receipt_header in receipt_lines
    header_index = receipt_lines.index(receipt_header)
    rows = [
        [cell.strip() for cell in line[1:-1].split("|")]
        for line in receipt_lines[header_index + 2 : header_index + 6]
    ]
    assert [row[0] for row in rows] == ["presale", "campaign", "aftersale", "product"]
    assert all(len(row) == 12 for row in rows)
    assert all(row[1] == "SRC-92847D5B505F17C4" for row in rows)
    assert [row[2] for row in rows] == [
        "srcv_52af2c0a648a7f8c",
        "srcv_2eb1831b70eddfbc",
        "srcv_8e163328604d0765",
        "srcv_c5d5b8e6a761893d",
    ]
    assert len({row[2] for row in rows}) == 4
    assert all(row[3] == "EVD-G0-09-WORKBOOK-CLOSURE-20260830" for row in rows)
    assert all(row[4] == "EVD-G0-09-ACL-OWNER-BASELINE-20260830" for row in rows)
    assert all(row[8] == "EVD-G0-09-WORKBOOK-CLOSURE-20260830" for row in rows)
    assert all(row[10] == "EVD-G0-09-AUTHORITY-SOURCES-20260830" for row in rows)
    assert all(row[11] == "READY" for row in rows)
    _assert_same_line(
        ledger,
        "四行均为 `READY`",
        "total_rows = importable_rows + quarantined_rows",
        "四域共用物理来源、快照、ACL、质量与整体批准证据",
        "各自拥有可登记的逻辑版本 ID",
        "允许关闭 G0-09",
        "不代替 G0 签发",
    )
    _assert_same_line(
        ledger,
        "售后 `aftersale`",
        "SRC-92847D5B505F17C4",
        "canonical / current",
        "srcv_8e163328604d0765",
        "223 / 223 / 0",
        "公司业务号码",
        "EVD-G0-09-ACL-OWNER-BASELINE-20260830",
        "EVD-G0-09-WORKBOOK-CLOSURE-20260830",
    )
    assert "飞书 URL、doc / wiki / file token、资源标题" in ledger
    assert "真实 `revision / last_modified_at`、导出快照和原始审批不得进入 Git" in ledger
    _assert_same_line(ledger, "DEC-040", "正式内容发布", "飞书 `revision / version`", "受控系统保存导出快照与 SHA-256", "新的不可变 `srcv_*`", "不改变 G0-09")
    _assert_same_line(ledger, "`srcv_*` 复用现有机器合同格式", "随机生成", "不能由内容域、日期、标题、URL 或 token 推导")
    _assert_same_line(ledger, "上游版本缺失", "导出失败", "快照 hash 不匹配", "整次发布 fail-closed")

    # DEC-041 governs the upstream Feishu authoring ACL only. It must not replace
    # the product's agent/coach/owner claims or the database workload-role ACL.
    assert "### 飞书权限基线（DEC-041）" in ledger
    _assert_same_line(
        ledger,
        "客服只读的对象是",
        "已批准 current release",
        "不是飞书起草主源",
        "禁止坐席看到 `draft / in_review`",
    )
    _assert_same_line(
        ledger,
        "`ROLE-CONTENT-D1 / D2 / D3`",
        "编辑各自登记内容域",
        "不得修改成员、共享范围或所有者",
        "不使用共享账号",
    )
    _assert_same_line(
        ledger,
        "`USR-CONTENT-001 / ROLE-CONTENT-LEAD`",
        "负责复核和产品发布",
        "拥有飞书编辑权不自动获得产品发布权",
    )
    _assert_same_line(
        ledger,
        "当前单人阶段由同一 Owner",
        "修改共享",
        "禁止匿名、全员或“持链接可编辑”",
        "机器人 / API 默认只读",
    )
    _assert_same_line(
        ledger,
        "产品旧现行来源的 ACL 受控证据继续只作历史",
        "当前四域共用 `EVD-G0-09-ACL-OWNER-BASELINE-20260830`",
        "ACL 归属为 4/4",
        "不等于产品的飞书 OAuth / App RBAC 已实现或 `PROD-ACL-01` 已通过",
    )
    _assert_same_line(
        ledger,
        "DEC-058",
        "一个工作簿物理版本 / 四个逻辑域版本 / 一个收口包",
        "G0-03 / G0-09 / G0-13",
        "14/14",
        "15/15",
        "先签 G0",
        "再以不同证据 ID 签 `DEC-DDEV-01`",
    )
    _assert_same_line(product, "| 权限扩展 |", "`agent / coach / owner`", "不替换现有角色")
    assert "CREATE ROLE app_content_admin NOLOGIN" in raw_ddl
    assert "GRANT EXECUTE ON FUNCTION public.publish_content_release(TEXT,TEXT,TEXT,TEXT,TEXT) TO app_content_admin;" in raw_ddl
    assert "p_actor_role IS DISTINCT FROM 'owner'" in publish
    dec041_line = next(line for line in ledger.splitlines() if "| DEC-041 |" in line)
    assert "app_content_admin" not in dec041_line

    assert "v4.43" in scope and "DEC-058" in scope and "PROD-ACL-01" in scope
    _assert_same_line(
        scope,
        "| 9 |",
        "[x]",
        "EVD-G0-09-AUTHORITY-SOURCES-20260830",
    )
    _assert_same_line(
        scope,
        "飞书上游文档实际权限核验",
        "[ ]",
        "`L1 · SINGLE_OWNER`",
        "`EVD-G0-09-ACL-OWNER-BASELINE-20260830`",
        "ACL 归属为 4/4",
        "不证明产品 OAuth / App RBAC",
        "`PROD-ACL-01`",
    )
    _assert_same_line(scope, "回滚上一版本", "重验目标快照四域来源", "新的单调 `release_seq`", "不把 current 直接指回旧 release")
    scope_footer = scope.rstrip().splitlines()[-1]
    for token in (
        "Scope 与验收 v4.43",
        "15/15",
        "EVD-G0-SIGN-20260831",
        "EVD-DDEV-AUTH-20260831",
        "只放行 `DEV-M0`",
    ):
        assert token in scope_footer


def test_dec_042_content_governance_machine_contract_is_fail_closed_and_complete() -> None:
    """DEC-042 static machine contracts must close every content-governance bypass."""
    raw_ddl = _read("33-schema-v1-草案.sql")
    ddl = _strip_sql_comments(raw_ddl)
    spec = _read("openapi.v1.yaml")
    model = _read("26-话术库与自动事实数据模型.md")
    contract = _read("39-API合同与发布状态机-v1.md")
    ssot = _read("37-架构SSOT-v1.md")
    development_increment = _read_development("01-DEV-M1搜索合同增量.md")
    gate_board = _read("40-架构图与关卡状态.md")
    ledger = (DESIGN.parent / "02-G0责任与证据台账.md").read_text(encoding="utf-8")
    scope = (DESIGN.parent / "03-Scope与验收.md").read_text(encoding="utf-8")

    # FINAL machine lineage is immutable input to every generated migration and type bundle.
    assert SCHEMA_VERSION in raw_ddl.splitlines()[0]
    assert re.search(rf"^\s*version:\s+{re.escape(OPENAPI_VERSION)}\s*$", spec, flags=re.M)
    assert hashlib.sha256(raw_ddl.encode("utf-8")).hexdigest() == SCHEMA_SHA256
    assert hashlib.sha256(spec.encode("utf-8")).hexdigest() == OPENAPI_SHA256
    grammar_path = DESIGN.parents[2] / "sites" / "tests" / "customer-agent-schema-grammar.mjs"
    grammar = grammar_path.read_text(encoding="utf-8")
    assert hashlib.sha256(grammar.encode("utf-8")).hexdigest() == GRAMMAR_SHA256
    assert re.search(
        rf"parsedSql\.stmts\.length,\s*{GRAMMAR_SQL_STATEMENTS}\b",
        grammar,
    )
    assert re.search(
        rf"parsedFunctions\.plpgsql_funcs\.length,\s*{GRAMMAR_FUNCTION_BODIES}\b",
        grammar,
    )
    assert re.search(rf"dec042NegativeGuards:\s*{GRAMMAR_DEC042_GUARDS}\b", grammar)
    governance = _between(spec, "  x-content-governance:", "  x-http-json-body-max-bytes:")
    for token in (
        "decision: DEC-042",
        "SHA-256(JCS(normalized-governance-snapshot))",
        "allowedPlaceholderKeys: [order_id, date]",
        "placeholderValuesPersisted: false",
        "batchFatalClasses: [structure, security, source]",
        "publishableQuality: { status: clean, qualityGatePassed: true }",
    ):
        assert token in governance, f"OpenAPI DEC-042 metadata missing {token}"

    # Stable Question identity is supplied upstream, versioned, and never derived from row order.
    question_validator = _sql_function_last(ddl, "content_questions_are_valid")
    for field in (
        "question_id",
        "question_version",
        "question_text",
        "question_hash",
        "semantic_family_id",
        "origin_fingerprint",
        "origin_fingerprint_key_version",
        "source_asset_id",
        "source",
        "intent_taxonomy_version",
        "intent_id",
    ):
        assert field in question_validator
    assert "('manual','from_log','import')" in question_validator
    assert "question.value ->> 'question_hash' IS DISTINCT FROM public.content_question_hash(question.value)" in question_validator
    assert "row_number" not in question_validator.lower()
    question_table = _between(
        ddl,
        "CREATE TABLE IF NOT EXISTS script_questions (",
        "CREATE INDEX IF NOT EXISTS idx_scripts_published",
    )
    for field in (
        "question_id",
        "question_version",
        "question_hash",
        "semantic_family_id",
        "origin_fingerprint",
        "origin_fingerprint_key_version",
        "source_asset_id",
        "intent_taxonomy_version",
        "intent_id",
    ):
        assert field in question_table
    assert re.search(r"question_version\s+INTEGER\s+NOT NULL CHECK \(question_version >= 1\)", question_table)
    assert "PRIMARY KEY (question_id, question_version)" in question_table
    assert "CONSTRAINT script_question_origin_version_unique" in question_table
    assert "UNIQUE (origin_fingerprint_key_version, origin_fingerprint, question_version)" in question_table
    question_hash_fn = _sql_function(ddl, "content_question_hash")
    for field in (
        "question_id",
        "question_version",
        "question_text",
        "semantic_family_id",
        "source_asset_id",
        "source",
        "intent_taxonomy_version",
        "intent_id",
    ):
        assert f"'{field}'" in question_hash_fn
    publish = _sql_function(ddl, "publish_content_release")
    assert "stable question identity conflicts with published lineage" in publish
    assert "ON CONFLICT (question_id, question_version) DO NOTHING" in publish
    assert "existing.question_version >" in publish
    assert "existing.question_hash IS DISTINCT FROM" in publish
    assert "existing.origin_fingerprint_key_version IS DISTINCT FROM" in publish
    content_question = _between(spec, "    ContentQuestion:", "    SearchCandidate:")
    for field in (
        "question_id",
        "question_version",
        "question_text",
        "question_hash",
        "semantic_family_id",
        "origin_fingerprint",
        "origin_fingerprint_key_version",
        "source_asset_id",
        "source",
        "intent_taxonomy_version",
        "intent_id",
    ):
        assert f"- {field}" in content_question, f"ContentQuestion.required missing {field}"
    assert "上游给定的稳定随机 ID" in content_question
    assert "禁止从行号、排序或数组下标派生" in content_question
    file_import = _between(spec, "    FileImportRequest:", "    FeishuImportRequest:")
    assert "行号不是 question_id 的输入" in file_import
    _assert_same_line(contract, "Question 正文先脱敏", "question_hash", "origin_fingerprint")

    # Scope is explicit and fail-closed in authoring, search request, storage and result schemas.
    scripts = _between(ddl, "CREATE TABLE IF NOT EXISTS scripts (", "CREATE TABLE IF NOT EXISTS script_questions (")
    assert "public.content_questions_align_intent(questions_json, intent_taxonomy_version, intent_id)" in scripts
    for field in ("platform_scope", "product_scope_type", "product_scope_refs", "effective_from", "review_due_at"):
        assert field in scripts
    assert "pg_catalog.cardinality(platform_scope) > 0" in scripts
    assert "platform_scope <@ ARRAY['qianniu','douyin']::TEXT[]" in scripts
    assert "product_scope_type = 'storewide' AND pg_catalog.cardinality(product_scope_refs) = 0" in scripts
    assert "product_scope_type IN ('category','sku') AND pg_catalog.cardinality(product_scope_refs) > 0" in scripts
    scope_match = _sql_function(ddl, "content_scope_matches")
    for predicate in (
        "p_platform IN ('qianniu','douyin')",
        "p_platform = ANY(p_platform_scope)",
        "p_product_scope_type = 'storewide'",
        "p_product_context_type = p_product_scope_type",
        "p_product_context_ref = ANY(p_product_scope_refs)",
    ):
        assert predicate in scope_match
    query_table = _between(ddl, "CREATE TABLE IF NOT EXISTS query_events (", "CREATE TABLE IF NOT EXISTS candidate_impressions (")
    assert "product_context_type" in query_table
    assert "product_context_ref_hash" in query_table
    assert not re.search(r"^\s*product_context_ref\s+TEXT", query_table, flags=re.M)
    platform_scope = _between(spec, "    PlatformScope:", "    ProductScopeType:")
    assert "minItems: 1" in platform_scope and "maxItems: 2" in platform_scope
    assert "enum: [qianniu, douyin]" in platform_scope
    assert "禁止 null/[] 表示全平台" in platform_scope
    product_scope = _between(spec, "    ProductScopeType:", "    IntentTaxonomyVersion:")
    assert "enum: [storewide, category, sku]" in product_scope
    assert "storewide 必须为 []；category/sku 必须非空" in product_scope
    search_request = _between(spec, "    SearchRequest:", "    HitStatus:")
    for field in ("product_context_type", "product_context_ref"):
        assert f"- {field}" in search_request
    for title in ("storewide 检索无商品上下文", "category 精确上下文", "sku 精确上下文"):
        assert title in search_request
    search_candidate = _between(spec, "    SearchCandidate:", "    TelemetryStatus:")
    for field in ("platform_scope", "product_scope_type", "product_scope_refs"):
        assert f"- {field}" in search_candidate

    # Taxonomy is append-only and every clean/recommendable asset binds one active versioned intent.
    taxonomy = _between(
        ddl,
        "CREATE TABLE IF NOT EXISTS intent_taxonomy_versions (",
        "CREATE OR REPLACE FUNCTION public.content_text_array_is_nonblank_unique",
    )
    for table in ("intent_taxonomy_versions", "intent_taxonomy_entries", "intent_taxonomy_mappings"):
        assert f"CREATE TABLE IF NOT EXISTS {table}" in taxonomy
        assert f"{table}_immutable" in ddl
    assert "FOREIGN KEY (intent_taxonomy_version, intent_id)" in scripts
    assert "REFERENCES intent_taxonomy_entries(intent_taxonomy_version, intent_id)" in scripts
    finalizer = _sql_function(ddl, "finalize_content_import_validation")
    assert "clean row must bind an active taxonomy entry" in finalizer
    assert "entry.lifecycle <> 'active'" in finalizer
    quality_codes = _between(spec, "    ContentQualityIssueCode:", "    ContentImportUpsertRow:")
    for code in ("UNKNOWN_INTENT", "INTENT_MAPPING_REQUIRED", "UNRESOLVED_CONFLICT"):
        assert f"- {code}" in quality_codes

    # Machine shape makes high/conflict dual review mandatory; human contract fixes the two roles.
    for table_start, table_end in (
        ("CREATE TABLE IF NOT EXISTS scripts (", "CREATE TABLE IF NOT EXISTS script_questions ("),
        ("CREATE TABLE IF NOT EXISTS staging_scripts (", "CREATE INDEX IF NOT EXISTS idx_staging_batch"),
        ("CREATE TABLE IF NOT EXISTS release_items (", "CREATE INDEX IF NOT EXISTS idx_release_items_search_document"),
    ):
        table = _between(ddl, table_start, table_end)
        assert "(risk_level = 'high' OR has_conflict)" in table
        assert "review_mode = 'dual'" in table
        assert "secondary_review_evd IS NOT NULL" in table
    for token in ("- risk_level", "- risk_categories", "- has_conflict"):
        assert token in search_candidate
    for forbidden_review_projection in (
        "review_mode:",
        "primary_reviewer_id:",
        "primary_reviewer_role:",
        "primary_review_evd:",
        "secondary_reviewer_id:",
        "secondary_reviewer_role:",
        "secondary_review_evd:",
    ):
        assert forbidden_review_projection not in search_candidate
    import_upsert = _between(spec, "    ContentImportUpsertRow:", "    ContentImportWithdrawRow:")
    for forbidden_review_claim in (
        "review_mode:",
        "primary_reviewer_id:",
        "primary_reviewer_role:",
        "primary_review_evd:",
        "secondary_reviewer_id:",
        "secondary_reviewer_role:",
        "secondary_review_evd:",
        "quality_gate_passed:",
    ):
        assert forbidden_review_claim not in import_upsert
    _assert_same_line(
        contract,
        "high",
        "ROLE-CONTENT-LEAD",
        "ROLE-CS-MANAGER",
        "退款/赔付",
        "价格/折扣",
        "活动规则",
        "功效/安全宣称",
        "账号/隐私",
        "投诉/升级",
        "法律承诺",
    )
    review_decision = _sql_function(ddl, "record_content_review_decision")
    assert "SECURITY DEFINER" in review_decision
    assert "p_reviewer_role NOT IN ('ROLE-CONTENT-LEAD','ROLE-CS-MANAGER')" in review_decision
    assert "p_actor_capability IS DISTINCT FROM 'content_review_lead'" in review_decision
    assert "p_actor_capability IS DISTINCT FROM 'content_review_manager'" in review_decision
    assert "content_review_decisions_immutable" in ddl
    assert "worker payload cannot self-assert review or quality decisions" in finalizer
    for predicate in (
        "lead.reviewer_role = 'ROLE-CONTENT-LEAD'",
        "manager.reviewer_role = 'ROLE-CS-MANAGER'",
        "(r.risk_level = 'high' OR r.has_conflict)",
        "manager.decision_id IS NOT NULL",
        "manager.reviewer_subject_key_version = lead.reviewer_subject_key_version",
        "manager.reviewer_subject_hash <> lead.reviewer_subject_hash",
    ):
        assert predicate in finalizer

    # Placeholder values and rendered bodies never become API/DB/event fields.
    placeholder_guard = _sql_function(ddl, "content_template_placeholders_are_valid")
    for token in ("ARRAY['order_id','date']", "{\u8ba2\u5355\u53f7}", "{\u65e5\u671f}"):
        assert token in placeholder_guard
    assert "allowedPlaceholderKeys: [order_id, date]" in governance
    assert "placeholderValuesPersisted: false" in governance
    assert "必须原样来自当前 release_items" in search_candidate
    assert "值与渲染后正文不得进入 API 或事件" in search_candidate
    event_tables = _between(ddl, "CREATE TABLE IF NOT EXISTS query_events (", "CREATE TABLE IF NOT EXISTS iteration_tasks (")
    assert "answer_text" not in event_tables
    for forbidden_field in ("placeholder_values", "rendered_answer_text", "rendered_answer", "rendered_body"):
        assert not re.search(rf"^\s*{forbidden_field}\s*:", spec, flags=re.M)
        assert not re.search(rf"^\s*{forbidden_field}\s+(?:TEXT|JSONB|BYTEA)", ddl, flags=re.I | re.M)
    _assert_same_line(
        contract,
        "answer_text",
        "字节级",
        "客户端只可在受控内存",
        "缺必填值禁止复制",
        "二次确认",
        "值与渲染正文不得回传、落库或写日志",
        "release_id/script_id/script_version/content_hash",
    )

    # Fatal input failures cannot be downgraded to row quality; quarantined rows never publish.
    staging = _between(ddl, "CREATE TABLE IF NOT EXISTS staging_scripts (", "CREATE INDEX IF NOT EXISTS idx_staging_batch")
    assert "quality_status IN ('clean','quarantined')" in staging
    assert "quality_status = 'clean'" in staging and "quality_issue_codes = '[]'::jsonb" in staging
    assert "quality_status = 'quarantined'" in staging and "NOT quality_gate_passed" in staging
    assert "batch-fatal validation must not persist staging rows" in finalizer
    assert "CASE WHEN coalesce(r.operation, 'upsert') = 'withdraw' THEN 'clean' ELSE 'quarantined' END" in finalizer
    assert "quality_status = 'clean'" in publish and "quality_gate_passed" in publish
    assert "QUALITY_GATE_NOT_PASSED" in publish
    for table in ("content_quality_review_plans", "content_quality_review_evidence"):
        assert f"CREATE TABLE IF NOT EXISTS {table}" in ddl
        assert f"{table}_immutable" in ddl
    quality_plan = _sql_function(ddl, "freeze_content_quality_review_plan")
    for token in (
        "p_ordinary_population_count <= 500",
        "LEAST(",
        "GREATEST(100, pg_catalog.ceil(p_ordinary_population_count * 0.10)::INTEGER)",
        "pg_catalog.ceil(p_ordinary_population_count * 0.30)::INTEGER",
        "p_mandatory_full_review_count",
        "selection_manifest_hash",
        "sha256-ranked-v1",
        "OUTBOX_LEASE_LOST",
    ):
        assert token in quality_plan
    quality_evidence = _sql_function(ddl, "record_content_quality_review_evidence")
    for token in (
        "p_initial_sample_reviewed_count IS DISTINCT FROM v_plan.initial_sample_target",
        "p_mandatory_reviewed_count IS DISTINCT FROM v_plan.mandatory_full_review_count",
        "v_initial_rate <= 0.02",
        "v_initial_rate > 0.05",
        "p_expanded_sample_reviewed_count IS DISTINCT FROM v_plan.expanded_sample_target",
        "QUALITY_EXPANSION_REQUIRED",
        "QUALITY_THRESHOLD_MISMATCH",
        "p_conclusion IS DISTINCT FROM v_expected_conclusion",
    ):
        assert token in quality_evidence
    for token in (
        "FROM public.content_quality_review_plans plan",
        "JOIN public.content_quality_review_evidence evidence",
        "evidence.conclusion = 'passed'",
    ):
        assert token in publish
    assert "结构/安全/来源失败整批失败" in spec
    _assert_same_line(spec, "`clean + quality_gate_passed`", "才可发布")
    _assert_same_line(
        contract,
        "<=500",
        "501–5000",
        "10%",
        "min=100,max=300",
        ">2%",
        "30%",
        ">5%",
        "risk_level=high",
        "100%",
    )

    # Governance hash covers every mutable semantic dimension and forces a new script version.
    for function_name in ("jsonb_jcs", "content_governance_snapshot", "content_governance_hash"):
        assert f"CREATE OR REPLACE FUNCTION public.{function_name}" in ddl
    governance_hash = _sql_function(ddl, "content_governance_hash")
    assert "public.jsonb_jcs" in governance_hash and "'sha256'" in governance_hash
    for field in (
        "p_answer_text",
        "p_questions",
        "p_platform_scope",
        "p_product_scope_type",
        "p_product_scope_refs",
        "p_effective_from",
        "p_effective_to",
        "p_intent_taxonomy_version",
        "p_intent_id",
        "p_risk_level",
        "p_risk_categories",
        "p_has_conflict",
        "p_review_mode",
        "p_primary_reviewer_id",
        "p_primary_reviewer_role",
        "p_primary_review_evd",
        "p_secondary_reviewer_id",
        "p_secondary_reviewer_role",
        "p_secondary_review_evd",
        "p_placeholder_keys",
    ):
        assert field in governance_hash
    assert "s.content_hash IS DISTINCT FROM" in publish
    assert "version = sc.version + 1" in publish
    content_hash = _between(spec, "    ContentHash:", "    AuthoritativeSourceVersionId:")
    assert "SHA-256(JCS(normalized governance snapshot))" in content_hash
    assert "Answer、Question 映射、scope、taxonomy、risk/review、有效期或 placeholder 任一变更" in content_hash
    assert "新 script_version 和新 content_hash" in content_hash

    # The public runtime can only search through the scoped DEFINER reader; expiry is a strict bound.
    search_reader = _sql_function(ddl, "search_recommendable_scripts")
    for token in (
        "SECURITY DEFINER",
        "p_platform TEXT",
        "p_product_context_type TEXT",
        "p_product_context_ref TEXT",
        "is_candidate BOOLEAN",
        "candidate.script_id IS NOT NULL",
        "LEFT JOIN LATERAL",
        "FROM public.v_scripts_recommendable",
        "public.content_scope_matches",
    ):
        assert token in search_reader
    assert "now() < ri.effective_to" in ddl
    acl = _between(ddl, "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;", "COMMIT;")
    assert "GRANT EXECUTE ON FUNCTION public.search_recommendable_scripts(TEXT,TEXT,TEXT) TO app_runtime;" in acl
    assert not re.search(r"GRANT\s+SELECT\s+ON[^;]*\bv_scripts_recommendable\b[^;]*TO\s+app_runtime", acl, flags=re.I | re.S)
    assert not re.search(r"GRANT\s+SELECT\s+ON[^;]*\brelease_items\b[^;]*TO\s+app_runtime", acl, flags=re.I | re.S)

    # The Ddev-signed design remains immutable; the current machine increment lives in development.
    _assert_same_line(ssot, "DEC-042", "schema v1.12", DEV_M0_SCHEMA_SHA256, "OpenAPI 1.11.0", "G0", "Scope", "Ddev")
    _assert_same_line(
        development_increment,
        "DEV-M1 机器合同增量",
        "schema.v1.14",
        SCHEMA_SHA256,
        "OpenAPI `1.11.0`",
        OPENAPI_SHA256,
    )
    _assert_same_line(development_increment, "不修改、替代或重新签发", "37/46", "历史授权投影")
    _assert_same_line(gate_board, "3 实现设计", "Pass", "Ready", "不等于开发授权")
    _assert_same_line(
        gate_board,
        "组织授权门（不计入八关）",
        "G0 / Ddev 已签发",
        "14/14",
        "15/15",
        "EVD-G0-SIGN-20260831",
        "EVD-DDEV-AUTH-20260831",
    )
    for token in ("14/14", "15/15", "EVD-DDEV-AUTH-20260831", "DEV-M0"):
        assert token in ledger
    assert "15/15" in scope and "EVD-DDEV-AUTH-20260831" in scope and "只放行 `DEV-M0`" in scope


def test_cr_002_g1a_and_real_fwd_evidence_flow_is_acyclic() -> None:
    """Online REAL-FWD/G1b evidence may never become a prerequisite or rewrite path for G1a."""
    change = _read("47-CR-002搜索复制证据闭环.md")
    test_plan = _read("48-CR-002测试计划.md")

    _assert_same_line(change, "REAL-FWD", "G1b", "不得反向", "G1a")
    _assert_same_line(change, "G1a", "20 正例 + 12 安全负例 + 18 鲁棒样本", "不查询在线事件表")
    _assert_same_line(change, "train、G1a、G1b", "dataset/version/hash", "交集必须为 0")
    _assert_same_line(test_plan, "DS-001", "20+12+18", "不引用在线事件/REAL-FWD")
    _assert_same_line(test_plan, "DS-002", "只读冻结 dataset", "不查询 CR-002 在线事件表")
    _assert_same_line(test_plan, "DS-005", "train/G1a/G1b 泄漏扫描", "全部为 0")
    _assert_same_line(test_plan, "DS-008", "semantic promotion", "无 runtime→train 自动路径")


def test_phase1_work_order_dashboard_scope_is_unambiguous() -> None:
    project = DESIGN.parent
    current_docs = {
        name: (project / name).read_text(encoding="utf-8")
        for name in (
            "02-G0责任与证据台账.md",
            "03-Scope与验收.md",
            "20-设计-进行中/25-PRD草案-客服Agent一期.md",
            "20-设计-进行中/29-Dashboard产品说明.md",
            "20-设计-进行中/31-产品契约-v1.md",
        )
    }
    for name, text in current_docs.items():
        assert "工单分析" in text, f"{name} does not carry phase-one work-order analysis"
        assert "话术优化待办" in text, f"{name} does not separate the internal improvement workflow"

    ledger = current_docs["02-G0责任与证据台账.md"]
    scope = current_docs["03-Scope与验收.md"]
    prd = current_docs["20-设计-进行中/25-PRD草案-客服Agent一期.md"]
    dashboard = current_docs["20-设计-进行中/29-Dashboard产品说明.md"]
    contract = current_docs["20-设计-进行中/31-产品契约-v1.md"]

    for decision in ("DEC-030", "DEC-031", "DEC-WORKORDER-01", "DEC-ITERATION-TASK-01"):
        assert decision in ledger and decision in dashboard and decision in contract
    _assert_same_line(ledger, "工单分析", "work_order_*", "批准的 CSV/XLSX", "不写回源系统")
    _assert_same_line(ledger, "话术优化待办", "iteration_task*", "不承载业务工单明细")
    assert "CR-001" in prd and "CR-001" in scope
    for nav_item in (
        "概览与工具指标",
        "检索 / 复制流水",
        "工单分析",
        "话术优化待办",
        "内容导入、四域来源绑定与发布",
        "公告、同步与离线租约状态",
    ):
        assert nav_item in dashboard, f"Dashboard IA missing {nav_item}"
    _assert_same_line(dashboard, "工单分析", "work_order_*", "业务导出数据")
    _assert_same_line(dashboard, "话术优化待办", "iteration_task*", "内部改进流程")
    assert "不写回班牛" in dashboard and "原始数据出域" in dashboard

    for text in (scope, prd, contract):
        assert "20 条" in text and "12 条" in text and "18 条" in text
        assert "调参集" in text
        assert re.search(r"(?:不|互不|不可).{0,32}(?:重叠|混用)|互斥", text)
    _assert_same_line(prd, "Windows Electron", "macOS", "iOS / Android")
    _assert_same_line(contract, "Mock", "开发 / 演示", "真实飞书 OAuth", "RBAC")

    historical_docs = []
    for historical_path in (
        project / "99-历史" / "2026-08-04_客服Agent启动会逐字稿.md",
        project / "80-参考/客服Agent一页立项卡.md",
    ):
        historical = historical_path.read_text(encoding="utf-8")
        historical_docs.append(historical)
        assert "HISTORICAL / PRE-D0 SNAPSHOT" in historical
        assert "02-G0责任与证据台账.md" in historical
        assert "03-Scope与验收.md" in historical
    assert any("25-PRD草案-客服Agent一期.md" in text for text in historical_docs)

    d0_evidence = (project / "2026-08-04_D0启动会纪要.md").read_text(encoding="utf-8")
    assert "COMPLETED D0 EVIDENCE / IMMUTABLE SNAPSHOT" in d0_evidence
    assert "不单独定义当前一期范围" in d0_evidence
    review_index = (project / "90-评审/README.md").read_text(encoding="utf-8")
    assert "历史 PRE-D0 收口快照" in review_index
    assert "当前状态" in review_index and "现行一期范围" in review_index


def test_scorecard_is_historical_and_points_to_external_evidence() -> None:
    t = _read_history("38-架构10分记分卡.md")
    assert "历史" in t or "SUPERSEDED" in t
    assert "不是当前独立得分" in t or "不作当前" in t
    # It must point at real artifacts rather than treating its own prose as evidence.
    assert "33" in t and "39" in t and "37" in t
    assert "staging" in t.lower() or "staging_scripts" in t or "Staging" in t
    assert "PostgreSQL" in t or "Postgres" in t
    assert "禁止自证" in t or "不变量" in t or "可编码" in t


def test_adr_postgres_not_sqlite_only() -> None:
    t = _read("32-ADR-一期技术栈.md")
    assert "PostgreSQL" in t
    assert "非 SoR" in t or "缓存" in t
    assert "39" in t


def test_historical_docs_superseded() -> None:
    t28 = _read_history("28-自研vs中台WBS对照.md")
    t34 = _read_history("34-技术栈计划-autoplan.md")
    t36 = _read_history("36-冲10分方案.md")
    assert "SUPERSEDED" in t28 and "46-实现设计-开工包.md" in t28
    assert "SUPERSEDED" in t34 or "supersede" in t34.lower()
    assert "37" in t34
    assert "PostgreSQL" in t34 or "Postgres" in t34
    assert "SUPERSEDED" in t36 or "吸收" in t36
    assert "37" in t36


def test_archived_design_manifest_is_complete_and_outside_current_design() -> None:
    archived = {
        "20-产品与交互设计.md",
        "21-技术方案设计.md",
        "22-数据与知识库设计.md",
        "23-测试与灰度设计.md",
        "24-项目细则议程.md",
        "27-RAG方案与开源选型.md",
        "28-自研vs中台WBS对照.md",
        "34-技术栈计划-autoplan.md",
        "36-冲10分方案.md",
        "38-架构10分记分卡.md",
        "42-多视角架构再评分.md",
    }
    actual = {path.name for path in HISTORY.glob("*.md") if path.name != "README.md"}
    assert actual == archived, f"archive manifest drift: expected={sorted(archived)} actual={sorted(actual)}"
    for name in archived:
        assert not (DESIGN / name).exists(), f"archived document leaked back into current design: {name}"
        text = _read_history(name)
        assert "ARCHIVED" in text or "SUPERSEDED" in text, f"archive banner missing: {name}"


def test_no_sqlite_as_production_sor_in_ssot() -> None:
    t37 = _read("37-架构SSOT-v1.md")
    assert "SQLite 作为跨用户唯一 SoR" in t37 or "唯一权威" in t37
    # Explicit not-only
    assert "否决" in t37 or "禁止" in t37 or "NOT" in t37
    # Diagrams + NFR linked
    assert "40" in t37
    assert "41" in t37


def test_architecture_diagrams_three_kinds() -> None:
    t = _read("40-架构图与关卡状态.md")
    assert "系统上下文" in t or "Context" in t
    assert "容器" in t or "Container" in t or "运行时" in t
    assert "Publish" in t or "发布" in t
    assert "Announce" in t or "公告" in t or "ACK" in t
    # mermaid or substantial ASCII
    assert "mermaid" in t or "Electron" in t
    assert "PostgreSQL" in t or "Postgres" in t


def test_waterfall_gate_status() -> None:
    t = _read("40-架构图与关卡状态.md")
    _assert_same_line(t, "状态", "2026-09-05", "v1.36", "G0 / Ddev 已 Pass", "DEV-M0", "DEV-M1", "comparison v2 合同已通过 PR #23 合并", "G1a T4 BLOCKED / T5 ATTEMPTED / BLOCKED")
    for gate in ("1 需求分析", "2 架构设计", "3 实现设计", "4 代码开发", "5 单元测试", "6 系统测试", "7 上线发布", "8 生产运维"):
        assert gate in t, f"missing gate {gate}"
    assert "组织授权门（不计入八关）" in t
    # completed design, current organizational authorization, and future gates are distinct
    assert "Pass" in t
    assert "DEV-M1 complete · G1a T4 BLOCKED / T5 ATTEMPTED / BLOCKED" in t
    assert "W1" in t
    assert "Not started" in t or "未开始" in t or "Not started" in t
    _assert_same_line(t, "2 架构设计", "PASS-WITH-CONDITIONS", "静态设计")
    _assert_same_line(t, "3 实现设计", "Pass", "Ready", "46", "不等于开发授权")
    _assert_same_line(
        t,
        "PG 证据校正",
        "schema.v1.12",
        DEV_M0_SCHEMA_SHA256,
        "本机隔离 PostgreSQL 15.18",
        "PASS-WITH-LIMITATION",
        "EVD-PG15-LOCAL-PREFLIGHT-20260821T212715+0800-47B66795",
    )
    _assert_same_line(
        t,
        "PG 证据校正",
        "`0001..0009`",
        "N-only",
        "`N/A`",
        "W5",
        "W6",
        "desktop 接库",
        "业务九端口",
        "managed PG",
        "backup-restore",
        "concurrency-deadlock",
        "production",
        "NOT_CERTIFIED / NOT_IMPLEMENTED",
    )

    t37 = _read("37-架构SSOT-v1.md")
    _assert_same_line(t37, "状态", "ARCHITECTURE DESIGN FROZEN", "PASS-WITH-CONDITIONS")
    _assert_same_line(t37, "架构设计关", "PASS-WITH-CONDITIONS", "静态设计")
    _assert_same_line(
        t37,
        "Current Schema v1.12 Reference DDL Local PG15 Preflight",
        "PASS-WITH-LIMITATION",
    )
    _assert_same_line(
        _read("../90-评审/2026-08-10_Codex交叉检查报告.md"),
        "Phase A 结论",
        "PASS-WITH-CONDITIONS",
        "静态设计",
    )
    t45 = _read("../90-评审/2026-08-10_Codex交叉检查报告.md")
    t46 = _read("46-实现设计-开工包.md")
    development_increment = _read_development("01-DEV-M1搜索合同增量.md")
    _assert_same_line(t45, "日期", "2026-08-13", "v1.41")
    _assert_same_line(t45, "责任入口复核", "13 个角色", "唯一 RACI", "七类 Owner")
    _assert_same_line(
        t45,
        "Ddev 授权复核",
        "DEC-DDEV-01",
        "14/14",
        "15/15",
        "PREPARED",
        "13/14",
        "14/15",
        "Ddev 为空",
    )
    _assert_same_line(
        t45,
        "`tests/test_arch_ssot_invariants.py`",
        "v1.41 PASS",
        "37/37",
        "13/14",
        "14/15",
        "27/29",
        "费用 / WBS",
    )
    _assert_same_line(t45, "G0-14 / G0-15", "均已 Pass", "Scope #15 已勾选")
    _assert_same_line(t45, "`sites/npm run test:all`", "v1.34 PASS", "Node 128/128", "Python 37/37")
    _assert_same_line(
        t45,
        "当前冻结为",
        "OpenAPI 1.11.0",
        "37 v1.16",
        "39 v1.15",
        "40 v1.18",
        "schema v1.12",
        "41 v1.13",
        "43 v1.6",
        "46 v1.19",
        "48 v0.5",
        "50 v0.4",
    )
    _assert_same_line(t46, "日期", "2026-08-30", "v1.22")
    _assert_same_line(
        t46,
        "Ddev 前**静态安全启动矩阵**",
        "[x]",
        "EVD-G0-11-SECURITY-BOUNDARY-20260810",
        "EVD-G0-12-OPS-DEPLOYMENT-20260810",
        "EVD-G0-07-FEE-PATH-20260813",
        "不证明 runtime",
    )
    _assert_same_line(t46, "Ddev 证据存在", "[ ]")
    _assert_same_line(t46, "| v1.7 |", "2026-08-07", "PG15.18")
    _assert_same_line(t46, "| v1.8 |", "2026-08-07", "DEC-DDEV-01", "DEV-M0～M4")
    _assert_same_line(
        t46,
        "| v1.11 |",
        "2026-08-09",
        "N/N-1",
        "PlatformAdapter",
        "迁移兼容矩阵",
        "schema.v1.8",
        "NOT_CERTIFIED",
    )
    _assert_same_line(
        t46,
        "| v1.12 |",
        "2026-08-09",
        "Pass · Document Package Ready",
        "CR-003",
        "组织授权门",
        "Ddev",
    )
    _assert_same_line(
        t46,
        "| v1.13 |",
        "2026-08-09",
        "CR-004",
        "四域 immutable release bindings",
        "运行实现与证据仍待 Ddev 后里程碑",
    )
    _assert_same_line(
        t46,
        "| v1.14 |",
        "2026-08-10",
        "DEC-042",
        "稳定 Question ID/版本/hash",
        "机器合同与运行实现仍未完成",
        "G0 / Scope / Ddev 不变",
    )
    _assert_same_line(
        t46,
        "| v1.15 |",
        "2026-08-10",
        "DEC-042 静态机器闭环",
        "受控 search",
        "审核决定",
        "质量 plan/evidence",
        "迁移/runtime/动态证据仍待 Ddev",
    )
    _assert_same_line(
        t46,
        "| v1.16 |",
        "2026-08-10",
        "DEC-042 postfix",
        "population_manifest_hash",
        "完整 snapshot",
        "public mapper",
        "source-denial",
        "G0 / Scope / Ddev 不变",
    )
    _assert_same_line(
        t46,
        "| v1.17 |",
        "2026-08-10",
        "消除 Ddev / DEV-M0 循环",
        "reference DDL 隔离预检",
        "DEV-M0 Done",
        "不降低 Owner、安全、G0 或 Ddev 门",
    )
    _assert_same_line(
        t46,
        "| v1.18 |",
        "2026-08-10",
        "reference DDL 本机隔离 PostgreSQL 15.18 预检",
        "PASS-WITH-LIMITATION",
        "immutable migration / N/N-1 / runtime",
        "G0 / Scope / Ddev / Gate / 代码状态",
    )
    _assert_same_line(
        t46,
        "| v1.19 |",
        "2026-08-10",
        "七类 Owner",
        "EVD-RACI-ACCEPTANCE-PACK-20260810",
        "G0 / Ddev",
    )
    assert "usage_outcome" not in t46 and "usage-outcome" not in t46
    assert "G0 Pass 或明确原型授权后开工" not in t
    _assert_same_line(
        t,
        "组织授权门（不计入八关）",
        "Pass · G0 / Ddev 已签发",
        "EVD-G0-SIGN-20260831",
        "EVD-DDEV-AUTH-20260831",
        "初始即时范围 DEV-M0",
        "DEV-M1 后续按独立授权完成",
    )
    _assert_same_line(t, "4 代码开发", "DEV-M1 complete", "G1a T4 BLOCKED / T5 ATTEMPTED / BLOCKED", "PR #26", "main@04c90b3", "33943165306", "负责人承接已确认", "NOT_SIGNED / NOT_EVALUATED", "负责人承接合同落地与版本化新包准备")
    _assert_same_line(t, "Ddev 后的开发", "G1A-E0 T1～T3", "PR #23", "main@b0a52d9", "33889553752", "T4", "首次 T5", "NOT_SIGNED / NOT_EVALUATED")
    _assert_same_line(t, "| v1.32 |", "PR #17～#20", "33785347931", "5cf650c")
    _assert_same_line(t, "| v1.35 |", "PR #23", "33889553752", "main@b0a52d9", "T4 READY", "T5 NOT STARTED / NOT_EVALUATED")
    _assert_same_line(t, "| v1.36 |", "EVD-G1A-RUN-01", "EVD-G1A-CLEANUP-01", "T5 ATTEMPTED / BLOCKED", "NOT_EVALUATED")
    assert "真 PG、OAuth" not in t45
    _assert_same_line(t45, "修补后也不自签 10", "上一发布版本升级", "托管 PG", "并发/死锁", "备份恢复", "生产环境")
    publish = _between(t45, "## 10. DEC-PUBLISH-01", "**签字式结论：**")
    assert "CANDIDATE_NOT_APPROVED" in publish
    assert "当前不声明精确路径数" in publish
    assert "不得解释为当前工作树状态" in publish
    assert "--verify-staged" in publish
    assert "STAGED_MATCH" in publish
    assert "真实临时 Git" in t45
    assert all(term in t45 for term in ("blob", "mode", "额外 staged 路径"))
    assert not re.search(r"审批摘要 SHA-256：.*`[0-9a-f]{64}`", publish)
    assert "精确文件清单（待批准）" not in t45
    _assert_same_line(t45, "全库 Markdown 本地链接", "PASS", "缺失 0")
    link_check_line = next(
        line for line in t45.splitlines() if "全库 Markdown 本地链接" in line
    )
    assert "不冻结易随文档增量漂移的链接总数" in link_check_line
    security_regression_line = next(
        line for line in t45.splitlines() if "公开边界与敏感路径回归" in line
    )
    assert "Security Owner" in security_regression_line
    assert (
        "v1.37 待复核" in security_regression_line
        or re.search(r"v1\.37.*\bPASS\b", security_regression_line)
    ), "v1.37 security regression must be explicitly pending or passed, never implied"
    for evidence_doc in (t37, t45, t46):
        assert "PASS-WITH-LIMITATION" in evidence_doc
        assert "NOT_CERTIFIED" in evidence_doc
        assert "Ddev" in evidence_doc
    ready = _between(t46, "### Ready for DEV-M0", "### Done for DEV-M0")
    assert ready.count("- [x]") == 8
    _assert_same_line(ready, "- [x]", "OpenAPI 路径与单向生成方向已冻结", "仅静态合同")
    _assert_same_line(ready, "- [x]", "历史旧 schema 快照", "HISTORICAL PASS-WITH-LIMITATION")
    _assert_same_line(ready, "- [x]", "CR-004", "静态机器合同", "已在同一候选 changeset 对齐")
    _assert_same_line(ready, "- [x]", "DEC-042 人读实现/测试设计已拆清", "静态文档完成")
    _assert_same_line(ready, "- [x]", "schema.v1.12", "OpenAPI `1.11.0`", "只证明机器合同", "不证明 runtime")
    _assert_same_line(ready, "- [x]", "七类 Owner", "EVD-RACI-ACCEPTANCE-PACK-20260810")
    _assert_same_line(
        ready,
        "- [x]",
        "Ddev 前**静态安全启动矩阵**",
        "EVD-G0-11-SECURITY-BOUNDARY-20260810",
        "EVD-G0-12-OPS-DEPLOYMENT-20260810",
        "EVD-G0-07-FEE-PATH-20260813",
        "不证明 runtime",
    )
    _assert_same_line(ready, "- [ ]", "Ddev 证据存在")
    _assert_same_line(
        ready,
        "- [x]",
        "Ddev 前",
        "schema.v1.12",
        DEV_M0_SCHEMA_SHA256,
        "本机隔离 PG15.18",
        "静态设计预检",
        "PASS-WITH-LIMITATION",
        "EVD-PG15-LOCAL-PREFLIGHT-20260821T212715+0800-47B66795",
        "不得写成 migration/runtime 证据",
    )
    assert "Ddev 证据存在" in ready and "- [ ] Ddev 证据存在" in ready
    assert "DEC-042 的迁移/生成类型/服务端/客户端与动态负例" not in ready
    done_m0 = _between(t46, "### Done for DEV-M0", "### Done for each DEV milestone")
    _assert_same_line(
        done_m0,
        "- [ ]",
        "Ddev 通过后",
        "独立产品仓 `customer-agent-prototype`",
        "保留 Git 历史",
        "未从早期学习项目复制",
    )
    _assert_same_line(done_m0, "- [ ]", "contract_set_id", "来源 Git SHA", "OpenAPI / DDL 双哈希")
    _assert_same_line(done_m0, "- [ ]", "不可变 migration", "TypeScript 类型", "重生成零差异")
    _assert_same_line(done_m0, "- [ ]", "真 PG15", "N-only", "N-1 → N")
    _assert_same_line(done_m0, "- [ ]", "DEC-042", "runtime", "动态负例", "未以静态 parser 结果冒充")

    handoff = _between(t46, "### 3.1 双仓合同交接协议", "## 4. 九端口映射")
    for token in (
        '"schema": "customer-agent-contract-set/v1"',
        '"source_git_sha": "<40-hex-source-commit>"',
        '"source_path": "business-docs/01-客服Agent项目/20-设计-进行中/openapi.v1.yaml"',
        '"file": "openapi.v1.yaml"',
        '"bytes": 174476',
        '"source_path": "business-docs/01-客服Agent项目/20-设计-进行中/33-schema-v1-草案.sql"',
        '"file": "schema-v1.12.sql"',
        '"bytes": 346632',
        "export_customer_agent_contract_set.mjs",
        "完整 40 位",
        "不读当前工作树",
        "拒绝覆盖",
    ):
        assert token in handoff
    for anchor in ("机器合同已锁定为", "实际产物必须精确匹配"):
        anchor_lines = [line for line in t46.splitlines() if anchor in line]
        assert anchor_lines, f"missing implementation hash anchor: {anchor}"
        for line in anchor_lines:
            assert DEV_M0_SCHEMA_SHA256 in line and OPENAPI_SHA256 in line, line
    for anchor in ("DEV-M1 机器合同增量", "实际产物必须精确匹配"):
        anchor_lines = [line for line in development_increment.splitlines() if anchor in line]
        assert anchor_lines, f"missing development increment hash anchor: {anchor}"
        for line in anchor_lines:
            assert SCHEMA_SHA256 in line and OPENAPI_SHA256 in line, line
    assert len(_read("openapi.v1.yaml").encode("utf-8")) == 174476
    assert len(_read("33-schema-v1-草案.sql").encode("utf-8")) == 347716

    contract_set_tool = (
        DESIGN.parent.parent / "08-工具" / "export_customer_agent_contract_set.mjs"
    ).read_text(encoding="utf-8")
    for token in (
        "完整 40 位 commit SHA",
        "cat-file",
        "O_NOFOLLOW",
        "check-ignore",
        "REUSED",
        "CREATED",
        "ddev_authorized: false",
        "product_consumed: false",
    ):
        assert token in contract_set_tool
    package_json = (DESIGN.parents[2] / "sites" / "package.json").read_text(encoding="utf-8")
    assert '"export:customer-agent-contract-set"' in package_json
    assert '"test:customer-agent-contract-set"' in package_json

    ledger = (DESIGN.parent / "02-G0责任与证据台账.md").read_text(encoding="utf-8")
    ddev_record = _between(ledger, "### DEC-DDEV-01 · 一期开发授权记录", "\n---")
    _assert_same_line(
        ddev_record,
        "当前状态",
        "PASS",
        "DDEV AUTHORIZED",
        "DEV-M0 ONLY",
    )
    _assert_same_line(ddev_record, "G0 依据", "14 / 14", "15 / 15", "EVD-G0-SIGN-20260831")
    _assert_same_line(ddev_record, "授权证据", "EVD-DDEV-AUTH-20260831")
    _assert_same_line(ddev_record, "授权总边界", "A · 条件式授权", "DEV-M0～DEV-M4", "§13.2")
    _assert_same_line(ddev_record, "即时放行", "仅允许进入 DEV-M0", "不得跨过 DEV-M0")
    _assert_same_line(ddev_record, "明确不授权", "生产部署", "真实坐席试点", "付费调用", "stage / commit / push")
    _assert_same_line(ddev_record, "| 结论 |", "`PASS`")
    _assert_same_line(ledger, "DEC-032", "A · 条件式授权", "只即时放行 DEV-M0", "不代表当前 Ddev 已签")

    d04 = _read("diagrams/04-瀑布全生命周期.puml")
    _assert_same_line(d04, "本项目状态", "通过", "文档包 Ready")
    _assert_same_line(d04, "2026-08-10 Codex", "90", "冻结评审", "46")
    _assert_same_line(d04, "组织授权门", "G0 / Ddev 已 Pass", "不计入八关")
    _assert_same_line(d04, "EVD-G0-SIGN-20260831", "EVD-DDEV-AUTH-20260831")
    _assert_same_line(d04, "即时只放行", "DEV-M0")
    _assert_same_line(d04, "产品仓 DEV-M0 与 DEV-M1 COMPLETE")
    _assert_same_line(d04, "G1A-E0 T1～T3 + comparison v2", "COMPLETE", "MERGED", "44/44")
    _assert_same_line(d04, "T4输入包", "BLOCKED", "历史静态READY不代表当前可运行")
    _assert_same_line(d04, "下一步", "负责人承接合同落地与版本化新包准备")
    _assert_same_line(d04, "DEC-SEARCH-01", "PASS-WITH-CONDITIONS")
    _assert_same_line(d04, "真实G1a", "NOT_EVALUATED", "DEV-M2", "NO-GO")
    assert "runner 50/50，但仍为NOT_SIGNED / NOT_EVALUATED" in d04
    _assert_same_line(d04, "历史 schema v1.12 reference DDL", "PG15", "PASS-WITH-LIMITATION")
    _assert_same_line(d04, "managed", "backup", "concurrency", "production", "NOT_CERTIFIED")
    _assert_same_line(d04, "旧 c1e74c EVD", "仅历史")
    _assert_same_line(d04, "升级", "并发", "生产", "真机", "未认证")


def test_nfr_four_hard_requirements() -> None:
    t = _read("41-NFR扩展并发与防改崩.md")
    assert "NFR 冻结包 v1.13" in t
    for kw in ("可拓展", "并发", "AI", "防改崩"):
        assert kw in t, f"missing NFR keyword {kw}"
    assert "50" in t and "150" in t
    assert "feature" in t.lower() or "flag" in t.lower() or "policy_flags" in t
    assert "fail-closed" in t.lower() or "Fail-closed" in t or "失败" in t
    assert "SearchBackend" in t
    assert "SearchQuery" in t and "RankedHit" in t
    assert "PushMethod" in t
    assert "RewriteWorker" in t or "rewrite_candidate" in t
    assert "300" in t or "QPS" in t
    assert "OVERLOADED" in t or "503" in t
    assert "pg_try_advisory" in t or "try_advisory" in t
    assert "cta-clipboard" in t
    assert "令牌桶" in t or "rate_limit" in t
    assert "不证明实现" in t or "不是实现" in t
    assert "压测" in t and "恢复" in t


def test_extension_compatibility_contracts_are_executable() -> None:
    """New requirements must extend through governed seams, not rewrite the core."""
    ssot = _read("37-架构SSOT-v1.md")
    api = _read("39-API合同与发布状态机-v1.md")
    nfr = _read("41-NFR扩展并发与防改崩.md")
    implementation = _read("46-实现设计-开工包.md")
    navigation = _read("README.md")
    gate_board = _read("40-架构图与关卡状态.md")

    _assert_same_line(ssot, "状态", "2026-08-10", "当前 v1.16", "PASS-WITH-CONDITIONS")
    _assert_same_line(ssot, "| **v1.10** |", "客户端 N/N-1", "PlatformAdapter", "迁移兼容矩阵")
    for invariant in ("INV-API-COMPAT", "INV-PLATFORM-ADAPTER", "INV-MIGRATION-COMPAT"):
        assert invariant in ssot, f"architecture SSOT missing {invariant}"
    _assert_same_line(ssot, "C · 破坏性", "新 major API", "ADR", "Scope/安全/费用", "Owner")
    _assert_same_line(ssot, "本节只冻结", "不批准任何新增功能")

    compat = _between(api, "### 0.3 API 演进", "### 0.4 身份 claims")
    _assert_same_line(compat, "首个签名 Pilot", "N")
    _assert_same_line(compat, "首个版本发布前", "N-1", "不得虚构")
    _assert_same_line(compat, "N-1", "90 个自然日", "连续 30 日", "回滚窗口")
    _assert_same_line(compat, "必须走 `/v2`", "删除/改名/改类型", "必填请求", "权限", "SoR/自动发送")
    _assert_same_line(compat, "CR-004 所需静态 wire/schema 元素", "新增请求字段必须有服务端安全默认", "不得注册路由或声称运行支持")

    platform = _between(nfr, "#### E. `PlatformAdapter`", "#### F. `PushAdapter`")
    assert "interface PlatformAdapter" in platform
    assert "detectAtUserIntent" in platform and "user_confirmation_required: true" in platform
    _assert_same_line(platform, "禁止后台轮询", "窗口标题", "聊天正文", "剪贴板内容/历史", "键盘输入")
    _assert_same_line(platform, "不得直接写", "query_events", "canonical", "SoR")
    _assert_same_line(platform, "不得自动发送", "写回外部平台", "PushAdapter")
    _assert_same_line(platform, "Phase 1", "manual|foreground_process|unknown", "三态写入")
    _assert_same_line(platform, "native_integration", "无论是否声称已确认", "403", "零写入")

    search_contract = _between(api, "### `POST /v1/search`", "### 2.1 中文检索物化合同")
    _assert_same_line(
        search_contract,
        "native_integration",
        "Phase 1",
        "403 `POLICY_DENIED`",
        "零写入",
        "客户端不得自行声明",
    )
    spec = _read("openapi.v1.yaml")
    assert f"version: {OPENAPI_VERSION}" in spec
    spec_ops = _openapi_operations(spec)
    assert len({path for _, path in spec_ops}) == 27, "CR-004 pre-N increment must not add a public /v1 path"
    assert len(re.findall(r"^  /(?:health|ready):\s*$", spec, flags=re.M)) == 2
    assert not re.search(r"^  /v2/", spec, flags=re.M), "breaking /v2 must not be registered in Phase 1"
    assert "nativePlatformIntegration: false" in spec
    search_route = _between(spec, "  /v1/search:", "  /v1/events/adoption:")
    assert "platform_source=native_integration" in search_route
    assert "#/components/responses/ForbiddenOrPolicyDenied" in search_route
    platform_source = _between(spec, "    PlatformSource:", "    InteractionReason:")
    assert "x-phase1-denied-values: [native_integration]" in platform_source
    assert "403 POLICY_DENIED 且零写入" in platform_source

    matrix = _between(implementation, "### 6.1.1 迁移兼容矩阵", "### 6.2 必测权限负例")
    for change_class in ("Additive", "Deprecation / Transition", "Breaking", "ACL / DEFINER"):
        assert change_class in matrix, f"migration matrix missing {change_class}"
    _assert_same_line(matrix, "不存在真实 `N-1`", "N/A · no prior signed baseline", "不得", "冒充")
    _assert_same_line(matrix, "第二个签名版本", "上一签名 schema/client fixture", "N-1 → N")
    _assert_same_line(
        matrix,
        "当前 `schema.v1.12`",
        "本机 PG15 预检",
        "PASS-WITH-LIMITATION",
        "immutable migration",
        "N/N-1",
        "NOT_CERTIFIED / NOT_IMPLEMENTED",
    )
    dev_m0 = _between(implementation, "| DEV-M0 合同骨架", "| DEV-M1 search+events")
    _assert_same_line(dev_m0, "N/N-1", "PlatformAdapter", "迁移矩阵")
    assert "Port: `notices`" not in api
    _assert_same_line(api, "`auth` 端口子能力", "`notices`", "不是第十端口")
    _assert_same_line(ssot, "`auth`", "`/v1/notices/*`", "不增加第十端口")
    auth_mapping = _between(implementation, "## 4. 九端口映射", "## 5. 依赖与事务调用顺序")
    _assert_same_line(auth_mapping, "auth", "/v1/notices/*", "子能力", "不增加第十端口")
    _assert_same_line(implementation, "CONTRACT", "native_integration", "403+零写入", "notices 归 auth 子能力")

    _assert_same_line(navigation, "更新", "2026-09-04", "CR-002", "CR-003", "CR-004", "DEC-042", "扩展治理")
    _assert_same_line(navigation, "扩展治理", "N/N-1", "PlatformAdapter", "迁移兼容矩阵", "不新增端口、路由或表")
    _assert_same_line(gate_board, "状态", "2026-09-05", "v1.36", "CR-002", "CR-003", "CR-004", "DEC-042", "comparison v2 合同已通过 PR #23 合并", "G1a T4 BLOCKED / T5 ATTEMPTED / BLOCKED", "扩展治理")
    _assert_same_line(gate_board, "2026-08-09 扩展治理收口", "N/N-1", "PlatformAdapter", "数据库变更", "不新增第十端口")
    _assert_same_line(gate_board, "| v1.4 |", "2026-08-09", "N/N-1", "PlatformAdapter", "迁移兼容矩阵", "NOT_CERTIFIED")


def test_multi_perspective_score_report() -> None:
    t = _read_history("42-多视角架构再评分.md")
    assert ("拓展" in t or "可拓展" in t) and "并发" in t and "AI" in t and "防改崩" in t
    assert "独立" in t or "对抗" in t or "设计完备" in t
    assert "未闭环" in t or "残余" in t
    assert "不等于" in t or "不证明" in t


def test_schema_nfr_tables() -> None:
    t = _read("33-schema-v1-草案.sql")
    assert "idempotency_keys" in t
    assert "outbox_jobs" in t
    assert "llm_ranker" in t or "autofill_adapter" in t
    assert "content_release_seq" in t
    assert "scripts_protect_published" in t or "trg_scripts_protect_published" in t
    assert "app.publishing" in t
    assert "rewrite_logs" in t
    # Codex P0 v1.2
    assert "pg_try_advisory_xact_lock" in t
    assert "publish_content_release" in t
    assert "rate_limit_take" in t
    assert "rate_limit_buckets" in t
    assert "release_items_immutable" in t
    assert "set_policy_flag" in t
    assert "rewrite_candidate" in t
    assert "tenant_id" in t
    assert "questions_json" in t
    assert "pending" in t and "lease_owner" in t
    assert "idempotency_claim" in t
    assert "idempotency_complete" in t
    assert "retry_after_sec" in t
    assert "MERGE" in t or "UNION ALL" in t
    assert "v_scripts_recommendable" in t and "content_current" in t
    assert "empty staging" in t or "v_ok_count" in t



def test_api_rate_limit_and_single_source() -> None:
    t = _read("39-API合同与发布状态机-v1.md")
    assert "RATE_LIMITED" in t
    assert "OVERLOADED" in t
    assert "release_items" in t
    assert "Idempotency" in t or "幂等" in t
    assert "fallback" in t.lower() or "降级" in t or "熔断" in t
    assert "base64url" in t or "next_cursor" in t
    assert "pg_try_advisory" in t or "try_advisory" in t
    assert "INV-BYPASS" in t
    assert "rate_limit_take" in t or "令牌桶" in t
    assert "IDEMPOTENCY_IN_FLIGHT" in t or "pending" in t
    assert "POST /v1/policy/flags" in t
    assert "release_id` 必填" in t or "release_id 必填" in t or "**`release_id` 必填**" in t


def test_nfr_scorecard_keeps_evidence_grades_separate() -> None:
    """Static design evidence must not masquerade as load/recovery certification."""
    t41 = _read("41-NFR扩展并发与防改崩.md")
    t42 = _read_history("42-多视角架构再评分.md")
    assert "不得" in t41 and ("高并发认证" in t41 or "压测" in t41)
    assert "设计" in t41 and "恢复" in t41
    for dim_label in ("可拓展", "并发设计", "AI", "防改崩"):
        assert dim_label in t41 or dim_label.replace("设计", "") in t41
    for evidence_grade in ("静态", "运行时"):
        assert evidence_grade in t42 or evidence_grade in t41


def test_current_contracts_live_in_normative_sources_not_historical_review() -> None:
    """39 owns search; 41/43 own NFR/SLI; the moved 44 snapshot is evidence only."""
    historical_path = DESIGN.parent / "90-评审" / "2026-08-06_架构交叉验证终裁快照.md"
    assert historical_path.is_file(), f"missing historical review snapshot: {historical_path}"
    historical = historical_path.read_text(encoding="utf-8")
    _assert_same_line(historical, "文档角色", "HISTORICAL REVIEW EVIDENCE", "非现行 SSOT")
    _assert_same_line(historical, "效力", "只作历史评审证据", "若与现行规范冲突", "现行规范为准")

    contract = _read("39-API合同与发布状态机-v1.md")
    search = _between(contract, "### 2.1 中文检索物化合同", "## 3. Port: `events`")
    for phrase in (
        "Unicode NFKC",
        "2-gram",
        "search_document",
        "search_fallback_text",
        "exact/ILIKE",
        "v_scripts_recommendable",
    ):
        assert phrase in contract or phrase in search, f"39 missing current search contract: {phrase}"
    _assert_same_line(search, "pg_trgm", "3-gram", "不得冒充 2-gram 主索引")

    nfr = _read("41-NFR扩展并发与防改崩.md")
    _assert_same_line(nfr, "单实例 search 应用内预算", "p95", "43", "800/1200ms", "待实现与压测取证")
    assert "一期可观测合同" in nfr and "RPO/RTO" in nfr

    deployment = _read("43-技术栈全景清单-部署向.md")
    _assert_same_line(deployment, "状态", "v1.6", "2026-08-08")
    sli = _between(deployment, "### 一期 SLI / 告警与恢复目标", "### 恢复清单")
    _assert_same_line(sli, "search 成功率", "≥ 99.5%", "连续 5min")
    _assert_same_line(sli, "search p95", "≤ 800ms", "≤ 1200ms", "10min")
    _assert_same_line(sli, "publish 成功率", "≥ 99%", "≥3 次/15min")
    _assert_same_line(sli, "429 占比", "15%", "5min")
    _assert_same_line(sli, "备份年龄", "24h", "26h")
    _assert_same_line(sli, "RPO / RTO", "RPO ≤ 24h", "RTO ≤ 4h", "演练前不认证")
    for field in ("request_id", "port", "user_id_hash", "release_id", "latency_ms", "error_code"):
        assert field in sli, f"43 missing structured-log field: {field}"


def test_arch_board_tabs_a11y_fit_mapping_and_offline() -> None:
    """The single-file board must remain an 8-panel, keyboard-operable offline artifact."""
    t = _read("架构图-PlantUML浏览器.html")
    assert "架构设计：通过 · PASS-WITH-CONDITIONS（含 CR-002、CR-003、CR-004、DEC-042 与扩展治理静态增量）" in t
    _assert_same_line(t, "CR-002 增量", "自动事实", "离线三维抽样")
    _assert_same_line(t, "CR-003 49/50", "仅训练预埋")
    _assert_same_line(
        t,
        "DEC-042 内容治理",
        "静态机器合同已锁",
        "稳定 Question",
        "search_recommendable_scripts",
        "质量 plan/evidence 分账",
    )
    _assert_same_line(
        t,
        "机器基线",
        "v1.12 / 1.11.0",
        "513 statements",
        "89 function bodies",
        "20 guards",
        "不等于迁移、类型或 runtime 已完成",
    )
    for invariant in (
        r"稳定\s*Question",
        r"显式\s*scope",
        r"taxonomy",
        r"双审",
        r"placeholder",
        r"quarantine",
        r"promoted_by_role",
        r"population_manifest_hash",
        r"非通用JCS",
    ):
        assert re.search(invariant, t), f"architecture board missing DEC-042 invariant: {invariant}"
    _assert_same_line(t, "扩展治理", "静态已冻结", "N/N-1", "PlatformAdapter", "迁移兼容矩阵", "不新增端口、路由或表")
    _assert_same_line(t, "当前推进项", "第 4 关代码开发", "G0=PASS", "Ddev=PASS", "DEV-M1 产品实施与退出证据已完成", "负责人承接合同落地与版本化新包准备", "待单独授权")
    _assert_same_line(t, "组织门禁", "G0 / Ddev Pass")
    _assert_same_line(t, "架构关", "Ddev 已独立签发", "真实问法", "Pilot", "上线仍须后续独立签发")
    _assert_same_line(t, "小白说明", "Ddev 已签发", "DEV-M1 产品实施与退出证据已完成", "纯合成工程范围", "真实来源", "生产")
    assert "必须等 Ddev 授权后完成迁移" not in t
    assert "迁移/runtime/托管PG/恢复/并发/生产仍未认证" not in t
    _assert_same_line(
        t,
        "组织门禁",
        "EVD-G0-SIGN-20260831",
        "EVD-DDEV-AUTH-20260831",
        "DEV-M0",
        "DEV-M1 产品实施与退出证据已完成",
        "负责人承接合同落地与版本化新包准备",
        "待单独授权",
    )
    _assert_same_line(t, "外部责任包 14/14", "Scope 15/15", "EVD-G0-SIGN-20260831", "EVD-DDEV-AUTH-20260831")
    for stale_gate_copy in (
        "外部责任包 4/14、Scope 5/15",
        "外部责任包 9/14、Scope 9/15",
    ):
        assert stale_gate_copy not in t, f"architecture board revives stale current status: {stale_gate_copy}"
    _assert_same_line(
        t,
        "冻结设计基线 schema v1.12",
        DEV_M0_SCHEMA_SHA256,
        "OpenAPI 1.11.0",
        OPENAPI_SHA256,
        "PASS-WITH-LIMITATION",
        "EVD-PG15-LOCAL-PREFLIGHT-20260821T212715+0800-47B66795",
    )
    _assert_same_line(t, "旧 c1e74c EVD", "仅为历史证据", "不能外推到冻结设计基线 schema")
    _assert_same_line(
        t,
        "../90-评审/2026-08-06_架构交叉验证终裁快照.md",
        "仅作历史证据",
        "非规范性 SSOT",
    )
    _assert_same_line(t, "L15", "41 承载 NFR", "43 承载 SLI/告警与恢复目标")
    assert "44-交叉验证终裁收尾.md" not in t
    assert "PG15/压测/真机证据待 Ddev" not in t
    assert "<DEC-042-SCHEMA-SHA>" not in t
    assert "schema v1.9" not in t and "schema v1.10" not in t and "schema v1.11" not in t
    assert re.search(
        r'<tr><th>2 架构设计</th><td><span class="gate pass">通过 · PASS-WITH-CONDITIONS（含 CR-002、CR-003、CR-004、DEC-042 与扩展治理静态增量）</span>',
        t,
    ), "waterfall board must show the architecture gate as passed"
    assert re.search(
        r"通过 · 文档包 Ready（含 CR-002/003/004[\/、]DEC-042 与扩展治理）；"
        r"技术设计已收口，不代表开发授权",
        t,
    )
    assert "组织授权门（不计入八关）" in t
    assert "DEV-M1 · 已完成（W0、W1、W2、W3、W4、W5 已收口）" in t
    _assert_same_line(t, "<footer>", "W4 migration / PG15 控制面 N-only 已验证", "真实 N-1 为 N/A", "业务 runtime")
    assert "DEV-M0 Ready · 未开始" not in t
    assert "八端口" not in t, "board prose must not revive the superseded eight-port architecture"
    assert "8 个端口" not in t and "8 个功能入口" not in t
    assert "九端口" in t
    for stale_outcome_copy in (
        "usage-outcome",
        "usage_outcome",
        "检索、复制与自报",
        "下一次唤起前一键选择",
        "未改/轻改/大改/重写后发送",
    ):
        assert stale_outcome_copy not in t, f"board revives removed forced outcome reporting: {stale_outcome_copy}"
    _assert_same_line(t, "离线三维抽样", "修改程度", "是否发送", "话术适用性")
    _assert_same_line(t, "Dashboard → metrics", "检索复制流水", "话术优化待办")
    _assert_same_line(t, "Dashboard → events", "状态变更", "浮窗写入")
    assert "Dashboard → workorders / content / events" not in t
    expected = [
        ("p1", "1 1期开发框架"),
        ("ctx", "2 系统上下文"),
        ("ctr", "3 容器与端口"),
        ("seq", "4 发布/检索时序"),
        ("wf", "5 瀑布八关"),
        ("views", "6 四视角"),
        ("stack", "7 技术栈与部署"),
        ("stackarch", "8 技术栈架构图"),
    ]

    tab_tags = re.findall(r'<button\b[^>]*\bclass="tab"[^>]*>.*?</button>', t, flags=re.S)
    assert len(tab_tags) == 8, f"expected 8 tabs, got {len(tab_tags)}"
    parsed_tabs: list[tuple[str, str]] = []
    for index, tag in enumerate(tab_tags):
        attrs = _html_attrs(tag)
        label = re.sub(r"<[^>]+>", "", tag[tag.find(">") + 1 : tag.rfind("</button>")]).strip()
        tab_id, expected_label = expected[index]
        parsed_tabs.append((attrs.get("data-id", ""), label))
        assert attrs.get("id") == f"tab-{tab_id}"
        assert attrs.get("role") == "tab"
        assert attrs.get("aria-controls") == f"panel-{tab_id}"
        assert attrs.get("aria-selected") == ("true" if index == 0 else "false")
        assert attrs.get("tabindex") == ("0" if index == 0 else "-1")
        assert label == expected_label
    assert parsed_tabs == expected
    assert 'role="tablist"' in t

    expected_tab_order = [tab_id for tab_id, _ in expected]
    tab_order_matches = re.findall(r"\bvar\s+TAB_ORDER\s*=\s*\[(.*?)\]\s*;", t, flags=re.S)
    assert len(tab_order_matches) == 1, (
        f"expected exactly one JavaScript TAB_ORDER declaration, got {len(tab_order_matches)}"
    )
    javascript_tab_order = re.findall(r'["\']([^"\']+)["\']', tab_order_matches[0])
    assert javascript_tab_order == expected_tab_order, (
        f"JavaScript TAB_ORDER drift: expected={expected_tab_order} actual={javascript_tab_order}"
    )

    panel_tags = re.findall(r'<section\b[^>]*\bclass="panel"[^>]*>', t)
    assert len(panel_tags) == 8, f"expected 8 tabpanels, got {len(panel_tags)}"
    for index, tag in enumerate(panel_tags):
        attrs = _html_attrs(tag)
        tab_id = expected[index][0]
        assert attrs.get("id") == f"panel-{tab_id}"
        assert attrs.get("data-id") == tab_id
        assert attrs.get("role") == "tabpanel"
        assert attrs.get("aria-labelledby") == f"tab-{tab_id}"
        assert (" hidden" in tag) == (index != 0)

    for key in ("ArrowRight", "ArrowLeft", "Home", "End"):
        assert f'e.key === "{key}"' in t, f"missing tab key handler {key}"
    assert "selectTab(TAB_ORDER[next], true);" in t
    assert "activeTab.focus();" in t

    fit = _between(t, "function fit(id, attempt)", "function setScale(id, s, anchor)")
    assert "vp.clientWidth < 40 || vp.clientHeight < 40" in fit
    assert "requestAnimationFrame" in fit
    assert "var contain = Math.min(wRatio, hRatio);" in fit
    assert "var scale = Math.min(1.2, contain * 0.96);" in fit
    assert "!Number.isFinite(scale) || scale <= 0" in fit
    assert "st.scale = Math.min(MAX, scale);" in fit
    assert not re.search(r"Math\.max\(\s*0\.\d+\s*,\s*(?:contain|wRatio|hRatio)", fit), (
        "fit must not impose a readability floor that makes the image overflow"
    )
    assert "panel && panel.hidden" in t, "hidden panels must not be measured before display"

    assert "http://127.0.0.1:8766" in t
    assert "8765" not in t, "stale local demo port hint"
    _assert_same_line(t, "APP_ENV=production", "AUTH_MODE=feishu", "/v1/auth/mock-login", "监听端口前拒启")
    assert "mock_auth" not in t, "board must not revive the removed DB auth flag"
    assert not re.search(
        r'<(?:script|link|img|iframe|source)\b[^>]*(?:src|href)\s*=\s*["\']https?://',
        t,
        flags=re.I,
    ), "offline board must not load external resources"
    for network_api in ("fetch(", "XMLHttpRequest", "WebSocket", "EventSource"):
        assert network_api not in t, f"offline board unexpectedly uses {network_api}"


def test_architecture_docs_and_diagram_sources_stay_aligned() -> None:
    t40 = _read("40-架构图与关卡状态.md")
    t43 = _read("43-技术栈全景清单-部署向.md")
    d02 = _read("diagrams/02-运行容器与端口.puml")
    d03 = _read("diagrams/03-发布与检索时序.puml")
    d04 = _read("diagrams/04-瀑布全生命周期.puml")
    d08 = _read("diagrams/08-1期开发框架.puml")

    assert "架构图-PlantUML浏览器.html" in t40 and "diagrams/" in t40
    assert "08-1期开发框架" in t40
    _assert_same_line(d08, "1期开发框架", "双闭环", "人在环", "禁代发")
    _assert_same_line(d08, "浮窗", "Top3", "复制剪贴板")
    _assert_same_line(d08, "工单分析", "话术优化待办")
    _assert_same_line(d08, "workorders", "批准 CSV/XLSX", "无写回")
    _assert_same_line(d08, "Dash", "Metrics", "指标/流水/待办读取")
    _assert_same_line(d08, "Dash", "Events", "话术待办状态变更")
    assert "Dash -[#000000]-> Events : 流水/复核" not in d08
    assert "不新增第十端口" in d08
    _assert_same_line(t40, "Owner->>API", "publish", "coach 只预览/修正")
    _assert_same_line(t40, "202", "validating", "import_batch_id")
    _assert_same_line(t40, "回滚", "owner", "新 release_seq", "audit")
    assert "Coach->>API: publish" not in t40
    assert "rolled_back" not in t40, "rollback is a new published release, not a new legacy state"
    _assert_same_line(d04, "架构设计", "产出：SSOT / ADR / C4 图 / NFR")
    assert "通过 · PASS-WITH-CONDITIONS" in d04
    assert "本项目状态：通过 · 文档包 Ready" in d04
    _assert_same_line(d04, "组织授权门", "G0 / Ddev 已 Pass", "不计入八关")
    _assert_same_line(d04, "EVD-G0-SIGN-20260831", "EVD-DDEV-AUTH-20260831")
    assert "产品仓 DEV-M0 与 DEV-M1 COMPLETE" in d04
    assert "DEC-SEARCH-01：PASS-WITH-CONDITIONS" in d04
    assert "G1A-E0 T1～T3 + comparison v2：COMPLETE · MERGED · 44/44" in d04
    assert "T4输入包：BLOCKED（历史静态READY不代表当前可运行）" in d04
    assert "下一步：负责人承接合同落地与版本化新包准备" in d04
    assert "真实G1a：NOT_EVALUATED；DEV-M2：NO-GO" in d04
    assert "runner 50/50，但仍为NOT_SIGNED / NOT_EVALUATED" in d04

    assert re.search(r"Search\s+-[^\n]*->\s+Policy\s*:", d02), "search must read phase1 policy"
    _assert_same_line(d02, "完整snapshot经最小mapper", "客户端按effective [from,to)过滤")

    _assert_same_line(d03, "202", "validating", "import_batch_id")
    _assert_same_line(d03, "异步", "validate(import_batch_id)")
    _assert_same_line(
        d03,
        "finalize_content_import_validation",
        "promoted_by_role",
        "ASCII键/C排序",
        "population manifest",
        "batch staged|failed",
    )
    _assert_same_line(d03, "Owner", "确认发布")
    assert "202 validating→staged" not in d03
    assert not re.search(r"Coach\s*->.*确认发布", d03)

    _assert_same_line(
        t43,
        "../90-评审/2026-08-06_架构交叉验证终裁快照.md",
        "历史证据",
        "不再承担现行规范",
    )
    for phrase in (
        "字级 bigram（2-gram）",
        "normalize(q)",
        "ILIKE / exact",
        "v_scripts_recommendable",
        "≥50 条",
        "20 正例 + ≥12 安全负例",
        "RPO ≤ 24h",
        "RTO ≤ 4h",
        "request_id, port, user_id_hash, release_id, latency_ms, error_code",
    ):
        assert phrase in t43, f"43 missing deployment contract: {phrase}"
    _assert_same_line(t43, "RATE_LIMIT_FAIL_CLOSED", "生产必须 `true`", "拒启")
    _assert_same_line(t43, "APP_ENV=production", "AUTH_MODE", "/v1/auth/mock-login", "监听端口前拒启")
    _assert_same_line(t43, "AUTH_MODE", "唯一", "数据库 policy flag", "不得")
    assert "mock_auth" not in t43, "43 must not revive the removed DB auth flag"
    mapping = _between(t43, "## 与架构图 Tab 的映射", "## 修订")
    expected_mapping = (
        ("1 系统上下文", "L0", "L12", "L7"),
        ("2 运行容器与端口", "L1", "L3", "L4", "L7", "L9", "L10"),
        ("3 时序", "L4", "L5"),
        ("4 瀑布关卡", "L16"),
        ("5 四视角", "岗位切图方法"),
        ("6 技术栈与部署", "L0–L16"),
        ("7 技术栈架构图", "L0–L5"),
    )
    for row in expected_mapping:
        _assert_same_line(mapping, *row)


def test_schema_has_no_destructive_recreate_and_phase1_flags_are_hard_banned() -> None:
    ddl = _read("33-schema-v1-草案.sql")
    active = _strip_sql_comments(ddl)
    assert not re.search(
        r"\bDROP\s+TABLE\s+IF\s+EXISTS\s+(?:public\.)?(?:idempotency_keys|outbox_jobs)\b",
        active,
        flags=re.I,
    ), "stateful tables must be upgraded in place, never drop/recreated"
    flag_seed = _between(active, "INSERT INTO policy_flags", "ON CONFLICT (flag_key) DO NOTHING;")
    assert "mock_auth" not in flag_seed, "AUTH_MODE must not be duplicated as a DB policy flag"
    assert re.search(
        r"DELETE\s+FROM\s+(?:public\.)?policy_flags\s+WHERE\s+flag_key\s*=\s*'mock_auth'\s*;",
        active,
        flags=re.I,
    ), "migration must remove the legacy DB auth flag"

    policy = _sql_function(active, "set_policy_flag")
    assert "p_actor_role IS DISTINCT FROM 'owner'" in policy
    allowed = re.search(r"p_flag_key\s+NOT\s+IN\s*\(([^)]*)\)", policy, flags=re.I | re.S)
    assert allowed, "set_policy_flag must use an explicit allowlist"
    assert "mock_auth" not in allowed.group(1)
    gate = re.search(
        r"IF\s+(p_flag_key\s+IN\s*\([^)]*\).*?)\s+THEN\s+RAISE\s+EXCEPTION\s+USING\s+"
        r"ERRCODE\s*=\s*'ZA004'.*?MESSAGE\s*=\s*pg_catalog\.format\('`?phase1 forbids[^']*'",
        policy,
        flags=re.I | re.S,
    )
    assert gate, "missing phase1 rewrite/auto_send hard gate"
    condition = gate.group(1)
    assert "rewrite" in condition and "auto_send" in condition and "p_flag_value IS TRUE" in condition
    assert "p_adr_id" not in condition, "ADR evidence must not bypass a phase boundary"

    hard_off = re.search(
        r"UPDATE\s+(?:public\.)?policy_flags\s+SET\s+flag_value\s*=\s*FALSE.*?"
        r"WHERE\s+flag_key\s+IN\s*\(\s*'rewrite'\s*,\s*'auto_send'\s*\)",
        active,
        flags=re.I | re.S,
    )
    assert hard_off, "an upgrade must force legacy phase1 dangerous flags back to false"

    contract = _between(
        _read("39-API合同与发布状态机-v1.md"),
        "### `POST /v1/policy/flags`",
        "### Redaction",
    )
    _assert_same_line(contract, "一期硬禁", "rewrite=true", "auto_send=true", "无条件 403")
    _assert_same_line(contract, "即使带 ADR", "不能越期")
    _assert_same_line(contract, "mock_auth", "400 `VALIDATION`")


def test_security_definer_acl_rollback_and_owner_only_publish() -> None:
    ddl = _strip_sql_comments(_read("33-schema-v1-草案.sql"))
    starts = list(
        re.finditer(
            r"CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)",
            ddl,
            flags=re.I,
        )
    )
    definer_names: set[str] = set()
    for index, match in enumerate(starts):
        end = starts[index + 1].start() if index + 1 < len(starts) else len(ddl)
        chunk = ddl[match.start() : end]
        if not re.search(r"\bSECURITY\s+DEFINER\b", chunk, flags=re.I):
            continue
        name = match.group(1)
        definer_names.add(name)
        assert re.search(
            r"SET\s+search_path\s*=\s*pg_catalog\s*,\s*public\s*,\s*pg_temp",
            chunk,
            flags=re.I,
        ), f"{name}: unsafe/missing fixed search_path"
        assert re.search(
            rf"REVOKE\s+(?:ALL|EXECUTE)\s+ON\s+FUNCTION\s+(?:public\.)?{re.escape(name)}\s*\([^;]*\)\s+FROM\s+PUBLIC\s*;",
            chunk,
            flags=re.I | re.S,
        ), f"{name}: missing active function-specific PUBLIC revoke"

    required_definers = {
        "set_policy_flag",
        "publish_content_release",
        "rollback_content_release",
        "enqueue_content_import",
        "cancel_content_import",
        "ack_client_release",
        "outbox_claim",
        "outbox_heartbeat",
        "outbox_retry",
        "reconcile_exhausted_content_imports",
        "claim_content_import_validation",
        "heartbeat_content_import_validation",
        "retry_content_import_validation",
        "finalize_content_import_validation",
        "outbox_complete",
    }
    assert required_definers <= definer_names, f"missing DEFINER functions: {required_definers - definer_names}"

    ack = _sql_function(ddl, "ack_client_release")
    for phrase in (
        "FOR UPDATE",
        "v_existing_user_id IS DISTINCT FROM p_user_id",
        "p_release_seq >= v_existing_seq",
        "p_offline_lease_token",
        "validate_snapshot_offline_lease",
        "last_seen_source_binding_hash",
        "last_ack_lease_token_hash",
    ):
        assert phrase in ack, f"ACK must be owner-bound and monotonic: {phrase}"
    assert "UPDATE public.snapshot_offline_leases" not in ack, "ACK must validate, not renew, the lease"

    publish = _sql_function(ddl, "publish_content_release")
    rollback = _sql_function(ddl, "rollback_content_release")
    for name, block in (("publish", publish), ("rollback", rollback)):
        assert "p_actor_role IS DISTINCT FROM 'owner'" in block, f"{name} must be owner-only in phase1"
    assert re.search(
        r"UPDATE\s+public\.import_batches\s+SET\s+status\s*=\s*'publishing'\s+"
        r"WHERE\s+import_batch_id\s*=\s*p_import_batch_id\s+AND\s+status\s*=\s*'staged'",
        publish,
        flags=re.I | re.S,
    ), "publish must atomically claim staged batch so cancel cannot race it"
    assert "GET DIAGNOSTICS v_batch_claimed = ROW_COUNT" in publish

    for phrase in (
        "nextval",
        "INSERT INTO public.content_releases",
        "INSERT INTO public.release_items",
        "WHERE ri.release_id = p_target_release_id",
        "rollback_of_release_id",
        "public.content_current",
        "public.announcements",
        "public.change_audits",
    ):
        assert phrase in rollback, f"rollback must create an audited new release: {phrase}"
    assert not re.search(
        r"current_release_id\s*=\s*p_target_release_id",
        rollback,
        flags=re.I,
    ), "rollback must replay the snapshot as a new release, not point current at history"

    api = _read("39-API合同与发布状态机-v1.md")
    publish_contract = _between(api, "### `POST /v1/content/publish`", "### `POST /v1/content/rollback`")
    rollback_contract = _between(api, "### `POST /v1/content/rollback`", "## 6. Port")
    _assert_same_line(publish_contract, "角色", "一期仅 owner", "coach 无配置旁路")
    _assert_same_line(rollback_contract, "角色", "一期仅 owner")
    assert "rollback_content_release" in rollback_contract
    _assert_same_line(
        _read("37-架构SSOT-v1.md"),
        "| 回滚 |",
        "owner",
        "release_seq",
        "禁止",
        "直指回旧 release",
    )


def test_idempotency_completion_is_lease_fenced() -> None:
    ddl = _strip_sql_comments(_read("33-schema-v1-草案.sql"))
    claim = _sql_function(ddl, "idempotency_claim")
    complete = _sql_function(ddl, "idempotency_complete")

    assert re.search(r"RETURNS\s+TABLE\s*\([^)]*lease_version\s+BIGINT", claim, flags=re.I | re.S), (
        "claim must return the fencing token"
    )
    assert re.search(
        r"SET\b.*?lease_version\s*=\s*[^,;]*lease_version\s*\+\s*1",
        claim,
        flags=re.I | re.S,
    ), "reclaim must advance lease_version"
    for parameter in ("p_lease_owner TEXT", "p_lease_version BIGINT"):
        assert re.search(r"\s+".join(map(re.escape, parameter.split())), complete, flags=re.I), (
            f"complete missing {parameter}"
        )
    for predicate in (
        r"lease_owner\s*=\s*p_lease_owner",
        r"lease_version\s*=\s*p_lease_version",
        r"status\s*=\s*'pending'",
    ):
        assert re.search(predicate, complete, flags=re.I), f"complete missing fencing predicate: {predicate}"
    assert "GET DIAGNOSTICS" in complete or "RETURNING" in complete
    assert "IDEMPOTENCY_LEASE_LOST" in complete

    contract = _between(
        _read("39-API合同与发布状态机-v1.md"),
        "### 0.2 幂等状态机",
        "### 0.3 API 演进",
    )
    _assert_same_line(contract, "complete", "lease_owner + lease_version", "IDEMPOTENCY_LEASE_LOST")


def test_outbox_worker_is_lease_fenced() -> None:
    ddl = _strip_sql_comments(_read("33-schema-v1-草案.sql"))
    claim = _sql_function(ddl, "outbox_claim")
    heartbeat = _sql_function(ddl, "outbox_heartbeat")
    complete = _sql_function(ddl, "outbox_complete")

    assert "FOR UPDATE SKIP LOCKED" in claim
    assert "j.status = 'pending'" in claim and "j.status = 'running'" in claim
    assert re.search(r"lease_version\s*=\s*j\.lease_version\s*\+\s*1", claim, flags=re.I)
    assert "clock_timestamp()" in claim
    assert "p_job_type NOT IN ('import_validate','work_order_import_validate')" in claim, (
        "generic claim must leave both import poison-job domains to their batch-aware reconcilers"
    )

    for name, block in (("heartbeat", heartbeat), ("complete", complete)):
        for predicate in (
            r"status\s*=\s*'running'",
            r"lease_owner\s*=\s*p_lease_owner",
            r"lease_version\s*=\s*p_lease_version",
            r"lease_expires_at\s*>\s*pg_catalog\.clock_timestamp\(\)",
        ):
            assert re.search(predicate, block, flags=re.I), f"{name} missing fencing predicate: {predicate}"
        assert "OUTBOX_LEASE_LOST" in block

    cancel = _sql_function(ddl, "cancel_content_import")
    assert re.search(r"lease_version\s*=\s*lease_version\s*\+\s*1", cancel, flags=re.I)
    assert "lease_owner = NULL" in cancel and "lease_expires_at = NULL" in cancel
    assert "completed_at = now()" in cancel
    assert "'diagnostic_id', v_diagnostic_id" in cancel
    assert "'reason', p_reason" not in _between(cancel, "UPDATE public.import_batches", "UPDATE public.outbox_jobs")
    assert "import_batch_error_report_shape" in ddl
    error_constraint = _between(ddl, "ADD CONSTRAINT import_batch_error_report_shape CHECK", "END IF;")
    assert "status = 'failed'" in error_constraint and "status <> 'failed'" in error_constraint
    assert "error_report IS NOT NULL" in error_constraint and "error_report IS NULL" in error_constraint
    assert "error_report ?& ARRAY['code','diagnostic_id']" in error_constraint
    assert "MAX_ATTEMPTS_EXHAUSTED" in error_constraint
    assert "error_report ?& ARRAY['attempts','max_attempts']" in error_constraint
    assert "error_report - ARRAY['code','diagnostic_id','attempts','max_attempts']" in error_constraint
    assert error_constraint.count("IS TRUE") >= 2, "CHECK must reject SQL NULL rather than pass via three-valued logic"
    assert "import_issue_codes_are_public(error_report -> 'issue_codes')" in error_constraint
    issue_check = _sql_function(ddl, "import_issue_codes_are_public")
    assert "jsonb_array_length(p_codes) <= 26" in issue_check
    assert "count(*) = pg_catalog.count(DISTINCT issue.code)" in issue_check
    assert "p_codes <@" in issue_check

    import_claim = _sql_function(ddl, "claim_content_import_validation")
    import_retry = _sql_function(ddl, "retry_content_import_validation")
    import_reconcile = _sql_function(ddl, "reconcile_exhausted_content_imports")
    assert import_claim.index("reconcile_exhausted_content_imports") < import_claim.index("outbox_claim")
    for name, block in (("retry", import_retry), ("reconcile", import_reconcile)):
        for phrase in (
            "MAX_ATTEMPTS_EXHAUSTED",
            "UPDATE public.import_batches",
            "status = 'failed'",
            "error_report",
            "UPDATE public.outbox_jobs",
        ):
            assert phrase in block, f"import {name} must close exhausted job + batch: {phrase}"
        assert block.index("FOR UPDATE") < block.index("UPDATE public.outbox_jobs"), (
            f"import {name} must keep batch -> outbox lock order"
        )
    assert "lease_version = j.lease_version + 1" in import_reconcile
    assert "lease_version = CASE WHEN j.attempts >= j.max_attempts" in import_retry
    assert "p_limit INT DEFAULT 10" in import_reconcile and "p_limit > 10" in import_reconcile
    assert "reconcile_exhausted_content_imports(1)" in import_claim
    assert "last_error = 'MAX_ATTEMPTS_EXHAUSTED'" in import_reconcile
    assert "last_error = v_safe_error_code" in import_retry
    for block in (import_reconcile, import_retry):
        assert "'diagnostic_id', v_diagnostic_id" in block
        assert "'last_error'," not in block, "raw outbox diagnostics must never enter public error_report"

    acl = _between(ddl, "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;", "COMMIT;")
    assert not re.search(r"GRANT\s+UPDATE\s+ON[^;]*\boutbox_jobs\b[^;]*TO\s+app_runtime", acl, flags=re.I | re.S)
    assert not re.search(
        r"GRANT\s+(?:INSERT|UPDATE|DELETE)[^;]*\b(?:outbox_jobs|import_batches|staging_scripts)\b"
        r"[^;]*TO\s+app_import_worker",
        acl,
        flags=re.I | re.S,
    ), "worker must mutate import/outbox state only through fenced DEFINER functions"
    assert not re.search(
        r"GRANT\s+SELECT\s+ON[^;]*\boutbox_jobs\b[^;]*TO\s+(?:app_runtime|app_import_worker)",
        acl,
        flags=re.I | re.S,
    ), "runtime/import worker must not read cross-capability outbox payloads"
    for function_name in (
        "claim_content_import_validation",
        "heartbeat_content_import_validation",
        "retry_content_import_validation",
        "finalize_content_import_validation",
    ):
        assert re.search(
            rf"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.{function_name}\s*\(",
            acl,
            flags=re.I,
        )
    for generic_name in ("outbox_claim", "outbox_heartbeat", "outbox_retry", "outbox_complete"):
        assert not re.search(
            rf"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.{generic_name}\s*\([^;]*"
            r"\)\s+TO\s+app_import_worker",
            acl,
            flags=re.I | re.S,
        ), f"import worker must not receive generic {generic_name} capability"

    finalize = _sql_function(ddl, "finalize_content_import_validation")
    for predicate in (
        r"j\.status\s*=\s*'running'",
        r"j\.lease_owner\s*=\s*p_lease_owner",
        r"j\.lease_version\s*=\s*p_lease_version",
        r"j\.lease_expires_at\s*>\s*pg_catalog\.clock_timestamp\(\)",
        r"j\.payload\s*->>\s*'import_batch_id'\s*=\s*p_import_batch_id",
    ):
        assert re.search(predicate, finalize, flags=re.I), f"finalize missing fencing predicate: {predicate}"
    for mutation in (
        "INSERT INTO public.staging_scripts",
        "UPDATE public.import_batches",
        "UPDATE public.outbox_jobs",
    ):
        assert mutation in finalize, f"fenced finalize missing atomic mutation: {mutation}"
    assert "OUTBOX_LEASE_LOST" in finalize
    assert "error_report contains non-public fields" in finalize
    assert "p_error_report - ARRAY['code','row','column','error_count','issue_codes']" in finalize
    assert "issue.code NOT IN" in finalize
    sql_issue_match = re.search(r"issue\.code\s+NOT\s+IN\s*\((.*?)\)", finalize, flags=re.I | re.S)
    assert sql_issue_match, "finalizer must machine-enforce the public issue-code allowlist"
    sql_issue_codes = set(re.findall(r"'([A-Z][A-Z0-9_]+)'", sql_issue_match.group(1)))
    assert sql_issue_codes == IMPORT_ISSUE_CODES, "OpenAPI and SQL issue-code allowlists drifted"
    assert "v_diagnostic_id := 'diag_'" in finalize
    assert "'diagnostic_id', p_error_report" not in finalize
    assert "v_public_error_report :=" in finalize
    assert "THEN p_error_report ELSE NULL" not in finalize
    assert re.search(
        r"GRANT\s+DELETE\s+ON[^;]*\bstaging_scripts\b[^;]*TO\s+cs_ai_definer",
        acl,
        flags=re.I | re.S,
    )

    contract = _between(
        _read("39-API合同与发布状态机-v1.md"),
        "### `POST /v1/content/import`",
        "### `GET /v1/content/import/{import_batch_id}`",
    )
    _assert_same_line(contract, "finalize_content_import_validation", "同一事务")
    _assert_same_line(contract, "status=running", "lease_owner", "lease_version", "clock_timestamp()")
    _assert_same_line(contract, "重试耗尽", "job=dead", "batch=failed", "error_report")
    _assert_same_line(contract, "claim_content_import_validation", "独立短事务", "COMMIT", "文件 I/O", "新事务")
    _assert_same_line(contract, "公开错误边界", "diagnostic_id", "additionalProperties:false", "原始诊断")


def test_work_order_worker_is_fenced_and_domain_separated() -> None:
    ddl = _strip_sql_comments(_read("33-schema-v1-草案.sql"))

    iteration_table = _between(
        ddl,
        "CREATE TABLE IF NOT EXISTS iteration_tasks (",
        "CREATE TABLE IF NOT EXISTS iteration_task_status_audits (",
    )
    work_order_table = _between(
        ddl,
        "CREATE TABLE IF NOT EXISTS work_order_records (",
        "CREATE TABLE IF NOT EXISTS work_order_export_audits (",
    )
    assert "sample_query_ids" in iteration_table and "suspected_cause" in iteration_table
    assert "import_batch_id" not in iteration_table and "source_record_hash" not in iteration_table
    assert "source_record_hash" in work_order_table and "normalization_version" in work_order_table
    for forbidden in ("raw_payload", "raw_row", "customer_id", "order_id", "external_writeback"):
        assert forbidden not in work_order_table, f"work-order records leaked forbidden field {forbidden}"
    assert "iteration_tickets" not in ddl

    generic_claim = _sql_function(ddl, "outbox_claim")
    generic_retry = _sql_function(ddl, "outbox_retry")
    generic_complete = _sql_function(ddl, "outbox_complete")
    for block in (generic_claim, generic_retry, generic_complete):
        assert "work_order_import_validate" in block, (
            "generic outbox functions must explicitly hand work-order imports to domain functions"
        )

    claim = _sql_function(ddl, "claim_work_order_import_validation")
    heartbeat = _sql_function(ddl, "heartbeat_work_order_import_validation")
    retry = _sql_function(ddl, "retry_work_order_import_validation")
    reconcile = _sql_function(ddl, "reconcile_exhausted_work_order_imports")
    finalize = _sql_function(ddl, "finalize_work_order_import_validation")
    assert claim.index("reconcile_exhausted_work_order_imports(1)") < claim.index("outbox_claim")
    assert "work_order_import_validate" in heartbeat
    for name, block in (("retry", retry), ("reconcile", reconcile)):
        for phrase in (
            "MAX_ATTEMPTS_EXHAUSTED",
            "UPDATE public.work_order_import_batches",
            "status = 'failed'",
            "UPDATE public.outbox_jobs",
            "diagnostic_id",
        ):
            assert phrase in block, f"work-order {name} missing terminal closure: {phrase}"
        assert block.index("FOR UPDATE") < block.index("UPDATE public.outbox_jobs"), (
            f"work-order {name} must lock batch before updating outbox"
        )
        assert "record_count = 0" in block and "accepted_count = 0" in block
        assert "rejected_count = 0" in block
    assert "lease_version = CASE WHEN j.attempts >= j.max_attempts" in retry
    assert "lease_version = j.lease_version + 1" in reconcile
    assert "p_limit INT DEFAULT 10" in reconcile and "p_limit > 10" in reconcile

    for predicate in (
        r"status\s*=\s*'running'",
        r"lease_owner\s*=\s*p_lease_owner",
        r"lease_version\s*=\s*p_lease_version",
        r"lease_expires_at\s*>\s*pg_catalog\.clock_timestamp\(\)",
    ):
        assert re.search(predicate, finalize, flags=re.I), f"work-order finalize missing {predicate}"
    for mutation in (
        "INSERT INTO public.work_order_records",
        "UPDATE public.work_order_import_batches",
        "UPDATE public.outbox_jobs",
    ):
        assert mutation in finalize
    assert "ready work-order import must contain at least one accepted record" in finalize
    assert "work-order record contains a non-allowlisted field" in finalize
    assert "work_order_issue_codes_are_public" in finalize

    error_constraint = _between(
        ddl,
        "ADD CONSTRAINT work_order_import_error_report_shape CHECK",
        "END IF;",
    )
    assert error_constraint.count("IS TRUE") >= 2
    assert "error_report - ARRAY[" in error_constraint
    assert "MAX_ATTEMPTS_EXHAUSTED" in error_constraint

    close_task = _sql_function(ddl, "close_iteration_task")
    assert "p_actor_user_id IS NULL" in close_task and "btrim(p_actor_user_id) = ''" in close_task

    acl = _between(ddl, "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;", "COMMIT;")
    for function_name in (
        "claim_work_order_import_validation",
        "heartbeat_work_order_import_validation",
        "retry_work_order_import_validation",
        "finalize_work_order_import_validation",
    ):
        assert re.search(
            rf"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.{function_name}\s*\(",
            acl,
            flags=re.I,
        )
    for generic_name in ("outbox_claim", "outbox_heartbeat", "outbox_retry", "outbox_complete"):
        assert not re.search(
            rf"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.{generic_name}\s*\([^;]*"
            r"\)\s+TO\s+app_work_order_worker",
            acl,
            flags=re.I | re.S,
        ), f"work-order worker must not receive generic {generic_name} capability"
    assert not re.search(
        r"GRANT\s+(?:INSERT|UPDATE|DELETE)[^;]*\b(?:work_order_import_batches|work_order_records|outbox_jobs)\b"
        r"[^;]*TO\s+app_work_order_worker",
        acl,
        flags=re.I | re.S,
    ), "work-order worker must mutate domain state only through fenced DEFINER functions"

    contract = _between(
        _read("39-API合同与发布状态机-v1.md"),
        "### `POST /v1/work-orders/imports`",
        "### `GET /v1/work-orders/imports/{import_batch_id}`",
    )
    _assert_same_line(
        contract,
        "reconcile_exhausted_work_order_imports",
        "job=dead",
        "batch=failed",
        "diagnostic_id",
    )


def test_schema_provenance_error_mapping_and_capability_roles() -> None:
    ddl = _strip_sql_comments(_read("33-schema-v1-草案.sql"))
    for role in (
        "app_runtime",
        "app_content_admin",
        "app_import_worker",
        "app_work_order_worker",
        "cs_ai_definer",
    ):
        assert re.search(rf"CREATE\s+ROLE\s+{role}\s+NOLOGIN", ddl, flags=re.I)
    assert "role_attribute_preflight" in ddl and "rolbypassrls" in ddl
    assert "granted_role.rolname" in ddl, "membership preflight must audit inbound and outbound grants"

    for sqlstate, code in (
        ("ZA001", "VALIDATION"),
        ("ZA002", "NOT_FOUND"),
        ("ZA003", "CONFLICT"),
        ("ZA004", "POLICY_DENIED"),
        ("ZA005", "INV_BYPASS"),
        ("ZA006", "LEASE_LOST"),
    ):
        assert sqlstate in ddl and code in ddl

    markdown = _read("39-API合同与发布状态机-v1.md")
    assert "禁止解析" in markdown and "MESSAGE" in markdown
    for sqlstate in ("ZA001", "ZA002", "ZA003", "ZA004", "ZA005", "ZA006"):
        assert sqlstate in markdown
    assert not re.search(r"\bP200[0-9]\b", markdown), "legacy private SQLSTATE codes drift from schema"

    for constraint in (
        "query_release_fk",
        "candidate_query_release_fk",
        "candidate_release_item_provenance_fk",
        "escalate_query_owner_fk",
        "client_sync_release_pair_fk",
    ):
        assert constraint in ddl
    assert re.search(r"release_id\s+TEXT\s+NOT\s+NULL", ddl, flags=re.I)
    assert re.search(r"content_hash\s+TEXT\s+NOT\s+NULL", ddl, flags=re.I)
    assert re.search(r"status\s+IN\s*\('resolved',\s*'wont_fix'\)\s+AND\s+resolution\s*=\s*status", ddl, flags=re.I)
    task_trigger = _sql_function(ddl, "trg_iteration_task_guard")
    assert "terminal iteration task is immutable" in task_trigger

    acl = _between(ddl, "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;", "COMMIT;")
    for privilege in ("SELECT", "INSERT", "UPDATE"):
        assert re.search(
            rf"GRANT\s+{privilege}\s+ON[^;]*\bclient_sync_state\b[^;]*TO\s+cs_ai_definer",
            acl,
            flags=re.I | re.S,
        )
    assert re.search(
        r"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.ack_client_release\s*\([^;]*\)\s+TO\s+app_runtime",
        acl,
        flags=re.I | re.S,
    )
    assert not re.search(
        r"GRANT\s+(?:INSERT|UPDATE)[^;]*\bclient_sync_state\b[^;]*TO\s+app_runtime",
        acl,
        flags=re.I | re.S,
    )
    assert re.search(
        r"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.freeze_content_quality_review_plan\s*\([^;]*\)\s+TO\s+app_import_worker",
        acl,
        flags=re.I | re.S,
    )
    for admin_only_function in (
        "record_content_review_decision",
        "record_content_quality_review_evidence",
    ):
        assert re.search(
            rf"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.{admin_only_function}\s*\([^;]*\)\s+TO\s+app_content_admin",
            acl,
            flags=re.I | re.S,
        )
        assert not re.search(
            rf"GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.{admin_only_function}\s*\([^;]*\)\s+TO\s+app_import_worker",
            acl,
            flags=re.I | re.S,
        )


def test_implementation_design_ddev_gate_owner_and_deadline_scope() -> None:
    implementation = _read("46-实现设计-开工包.md")
    ddev_gate = _between(implementation, "### 1.2 Ddev 硬门", "## 2. 技术栈冻结")

    owners = (
        "Product Owner",
        "Tech Owner",
        "Security Owner",
        "Content Owner",
        "QA Owner",
        "Ops Owner",
        "Cost Owner",
    )
    for owner in owners:
        assert owner in ddev_gate, f"Ddev entry gate missing {owner}"

    _assert_same_line(ddev_gate, "人员代号", "仓外受控真实身份映射", "接受职责 EVD")
    assert "Owner 的姓名与职责" not in ddev_gate
    assert "姓名为空" not in implementation
    assert "§13 的所有 P0 决策门" not in ddev_gate
    _assert_same_line(ddev_gate, "DEC-DDEV-01=PASS", "DEV-M0")
    _assert_same_line(ddev_gate, "一次覆盖", "DEV-M0～M4", "只即时放行 DEV-M0")
    assert "Ddev 不替代发布、部署、试点或付费授权" in ddev_gate
    assert "恢复演练" in ddev_gate and "对应时点取证" in ddev_gate
    _assert_same_line(ddev_gate, "DEC-PUBLISH-01=PASS", "stage/commit/push")
    _assert_same_line(ddev_gate, "其余决策门", "不前置阻塞 DEV-M0")

    decisions = _between(implementation, "### 13.2 决策门", "## 14. 两类工单工作流")
    assert "条件触发的停止门" in decisions
    assert "不按 P0/P1/P2 严重度计数" in decisions
    assert "不能把 DEV-M4/上线门倒置为 DEV-M0 前置条件" in decisions
    _assert_same_line(decisions, "DEC-DDEV-01", "DEV-M0～M4", "即时只放行 DEV-M0", "PREPARED")

    stop_conditions = _between(implementation, "## 15. G0 / 安全 / 上线停止条件", "## 16. Ban")
    _assert_same_line(stop_conditions, "[Ddev]", "七类 Owner", "职责接受证据")
    _assert_same_line(stop_conditions, "[启用外部模型]", "出域", "费用 cap", "止损")
    _assert_same_line(stop_conditions, "[Pilot / 上线]", "告警接收人", "值班", "支持责任")
    _assert_same_line(stop_conditions, "[上线]", "恢复演练")


def test_cross_validation_authority_and_oss_evidence_scope() -> None:
    historical_path = DESIGN.parent / "90-评审" / "2026-08-06_架构交叉验证终裁快照.md"
    verdict = historical_path.read_text(encoding="utf-8")
    _assert_same_line(verdict, "文档角色", "HISTORICAL REVIEW EVIDENCE", "非现行 SSOT")
    rubric = _between(verdict, "### 0.1 可复算评分尺", "## 1. 架构交叉验证")
    for anchor in ("`2.0`", "`1.9`", "`1.8`", "`1.6–1.7`", "`≤1.5`"):
        assert anchor in rubric, f"missing scoring anchor {anchor}"
    for perspective, total_label, expected_total in (
        ("企业架构", "企业架构合计", Decimal("9.6")),
        ("GitHub / OSS", "GitHub / OSS 合计", Decimal("9.0")),
        ("大厂 UI/UX", "大厂 UI/UX 合计", Decimal("9.1")),
        ("Figma 设计", "Figma 设计合计", Decimal("8.7")),
    ):
        rows = re.findall(
            rf"^\| {re.escape(perspective)} \|.*?\|\s*([0-9]+\.[0-9])\s*\|\s*([0-9]+\.[0-9])\s*\|",
            rubric,
            flags=re.M,
        )
        assert len(rows) == 5, f"{perspective} must have exactly five scoring dimensions"
        maxima = sum((Decimal(maximum) for maximum, _ in rows), Decimal("0"))
        actual = sum((Decimal(score) for _, score in rows), Decimal("0"))
        assert maxima == Decimal("10.0"), f"{perspective} maxima add to {maxima}"
        assert actual == expected_total, f"{perspective} scores add to {actual}, expected {expected_total}"
        _assert_same_line(rubric, total_label, "10.0", str(expected_total))

    appendix = _between(verdict, "## 3. 架构补洞记录（历史输入，现已吸收）", "## 4. 交叉验证收尾结论")
    _assert_same_line(appendix, "效力", "有效内容已吸收到 37 / 39 / 41 / 47 / 49", "只作历史评审证据")
    assert "以现行规范为准" in appendix and "不得从本节选择旧实现" in appendix

    oss_verdict = _between(verdict, "### 1.2 GitHub / OSS 架构视角", "### 1.3 架构到 10 分的必要条件")
    assert "本轮静态 OSS 审计 P0/P1/P2 = 0/0/0" in oss_verdict
    assert "Ddev 后" in oss_verdict and "不计入本轮静态 OSS P2" in oss_verdict

    architecture_ten = _between(verdict, "### 1.3 架构到 10 分的必要条件", "## 2. 架构图 HTML 交叉验证")
    assert "Owner" in architecture_ten and "验收证据" in architecture_ten
    assert "真 PG15 clean-install" in architecture_ten and "全新 Linux clone" in architecture_ten
    html_ten = _between(verdict, "### 2.3 HTML 到 10 分的必要条件", "因此 HTML 当前")
    assert "Owner" in html_ten and "验收证据" in html_ten
    assert html_ten.count("至少 5 名目标评审角色") == 2
    assert html_ten.count("成功率 100%") == 2

    report = _read("../90-评审/2026-08-10_Codex交叉检查报告.md")
    _assert_same_line(report, "当前本地 workspace 可复跑", "未跟踪候选", "fresh clone")
    _assert_same_line(report, "P2-01", "不计入当前静态 OSS P2")
    _assert_same_line(report, "P2-04", "git diff --check", "CLOSED")


def main() -> int:
    tests = [
        test_architecture_ssot_north_star,
        test_contract_defers_and_honest_push,
        test_prd_no_autofill_first_or_demo_skip_expiry,
        test_current_portfolio_dashboard_keeps_architecture_redlines,
        test_raci_is_the_single_13_role_intake_with_fixed_owner_projection,
        test_schema_postgres_first_and_invariants,
        test_api_contract_ports_and_state_machine,
        test_openapi_is_machine_contract_and_matches_markdown_routes,
        test_cr_002_search_copy_machine_contract_invariants,
        test_cr_004_authoritative_source_fail_closed_contract_is_static_and_complete,
        test_dec_042_content_governance_machine_contract_is_fail_closed_and_complete,
        test_cr_002_g1a_and_real_fwd_evidence_flow_is_acyclic,
        test_phase1_work_order_dashboard_scope_is_unambiguous,
        test_scorecard_is_historical_and_points_to_external_evidence,
        test_adr_postgres_not_sqlite_only,
        test_historical_docs_superseded,
        test_archived_design_manifest_is_complete_and_outside_current_design,
        test_no_sqlite_as_production_sor_in_ssot,
        test_architecture_diagrams_three_kinds,
        test_waterfall_gate_status,
        test_nfr_four_hard_requirements,
        test_extension_compatibility_contracts_are_executable,
        test_multi_perspective_score_report,
        test_schema_nfr_tables,
        test_api_rate_limit_and_single_source,
        test_nfr_scorecard_keeps_evidence_grades_separate,
        test_current_contracts_live_in_normative_sources_not_historical_review,
        test_arch_board_tabs_a11y_fit_mapping_and_offline,
        test_architecture_docs_and_diagram_sources_stay_aligned,
        test_schema_has_no_destructive_recreate_and_phase1_flags_are_hard_banned,
        test_security_definer_acl_rollback_and_owner_only_publish,
        test_idempotency_completion_is_lease_fenced,
        test_outbox_worker_is_lease_fenced,
        test_work_order_worker_is_fenced_and_domain_separated,
        test_schema_provenance_error_mapping_and_capability_roles,
        test_implementation_design_ddev_gate_owner_and_deadline_scope,
        test_cross_validation_authority_and_oss_evidence_scope,
    ]
    failed = 0
    for fn in tests:
        try:
            fn()
            print("PASS", fn.__name__)
        except Exception as e:
            failed += 1
            print("FAIL", fn.__name__, e)
    print(f"summary fail={failed} total={len(tests)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
