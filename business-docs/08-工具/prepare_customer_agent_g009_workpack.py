#!/usr/bin/env python3
"""把 G0-09 安全模板与售前/售后技术报告组装成仓外待签工作包。"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
DOMAINS = ("presale", "campaign", "aftersale", "product")
REPORT_DOMAINS = {"presale", "aftersale"}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def read_json(path: Path) -> dict[str, Any]:
    path = path.expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"JSON 文件不存在：{path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON 顶层必须是对象：{path}")
    return value


def validate_template(template: dict[str, Any]) -> None:
    if template.get("schemaVersion") != 1:
        raise ValueError("关闭清单 schemaVersion 必须为 1")
    rows = template.get("domains")
    if not isinstance(rows, list) or len(rows) != 4:
        raise ValueError("关闭清单必须恰好包含四域")
    names = [row.get("domain") for row in rows if isinstance(row, dict)]
    if names != list(DOMAINS):
        raise ValueError("关闭清单域顺序必须为 presale/campaign/aftersale/product")
    if any(row.get("readiness") not in {"INCOMPLETE", "READY"} for row in rows):
        raise ValueError("关闭清单 readiness 非法")


def validate_report(report: dict[str, Any], expected_domain: str) -> None:
    if expected_domain not in REPORT_DOMAINS:
        raise ValueError("技术报告只允许 presale 或 aftersale")
    if report.get("schema_version") != 1 or report.get("status") != "TECHNICAL_PREFILL":
        raise ValueError(f"{expected_domain} 技术报告版本或状态无效")
    if report.get("domain") != expected_domain:
        raise ValueError(f"技术报告错域：期望 {expected_domain}，实际 {report.get('domain')}")
    source = report.get("source")
    if not isinstance(source, dict) or source.get("extension") not in {".xlsx", ".csv"}:
        raise ValueError(f"{expected_domain} 技术报告缺少合法 source")
    if not isinstance(source.get("size_bytes"), int) or source["size_bytes"] <= 0:
        raise ValueError(f"{expected_domain} source.size_bytes 无效")
    if not SHA256_RE.fullmatch(str(source.get("sha256", ""))):
        raise ValueError(f"{expected_domain} source.sha256 无效")
    sheets = report.get("sheets")
    if not isinstance(sheets, list) or report.get("sheet_count") != len(sheets) or not sheets:
        raise ValueError(f"{expected_domain} 工作表统计无效")
    if "G0-09" not in report.get("does_not_authorize", []):
        raise ValueError(f"{expected_domain} 技术报告缺少不授权边界")


def compact_report(report: dict[str, Any]) -> dict[str, Any]:
    return {
        "domain": report["domain"],
        "status": report["status"],
        "source": report["source"],
        "sheet_count": report["sheet_count"],
        "sheets": [
            {
                "sheet_alias": sheet.get("sheet_alias"),
                "total_rows": sheet.get("total_rows"),
                "nonempty_rows": sheet.get("nonempty_rows"),
                "max_columns": sheet.get("max_columns"),
                "header_candidate_row": sheet.get("header_candidate_row"),
                "recognized_fields": sheet.get("recognized_fields", []),
                "sensitive_hit_counts": sheet.get("sensitive_hit_counts", {}),
                "scan_truncated": sheet.get("scan_truncated", False),
            }
            for sheet in report["sheets"]
        ],
        "sensitive_hit_counts": report.get("sensitive_hit_counts", {}),
        "interpretation": "FILE_RECEIVED_AND_PARSED_ONLY",
        "does_not_prove": ["canonical-source", "ACL", "formal-quality-counts", "content-approval", "G0-09"],
    }


def next_steps(template: dict[str, Any], reports: dict[str, dict[str, Any]]) -> str:
    closure_rows = {row["domain"]: row for row in template["domains"]}
    lines = [
        "# G0-09 四域待签工作清单",
        "",
        "> 状态：TECHNICAL_PREFILL。仅供受控区工作，不是 EVD，不改变 G0 / Scope / Ddev。",
        "",
        "| domain | 文件技术接收 | 关闭清单状态 | 下一步 |",
        "|---|---|---|---|",
    ]
    actions = {
        "presale": "确认唯一主源；生成 SRC/srcv；归档快照、ACL、正式质量与 Content Lead 批准",
        "campaign": "补独立 ACL、正式质量分母与四域整体批准",
        "aftersale": "确认唯一主源；生成 SRC/srcv；归档快照、ACL、正式质量与 Content Lead 批准",
        "product": "补正式质量分母与四域整体批准",
    }
    for domain in DOMAINS:
        received = "已收到并解析" if domain in reports else "本工作包未附报告"
        lines.append(f"| {domain} | {received} | {closure_rows[domain]['readiness']} | {actions[domain]} |")
    lines.extend([
        "",
        "## 使用边界",
        "",
        "- 技术报告中的行数仅描述文件结构，不得直接写入正式 quality_counts。",
        "- 文件 SHA 仅留在受控工作包，不进入公开台账或公开 Git。",
        "- 完成人工确认和证据归档后，单独填写 closure_manifest.json，再运行严格预检。",
    ])
    return "\n".join(lines) + "\n"


def build_workpack(template: dict[str, Any], reports: dict[str, dict[str, Any]]) -> dict[str, Any]:
    validate_template(template)
    for domain, report in reports.items():
        validate_report(report, domain)
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "TECHNICAL_PREFILL",
        "received_domains": [domain for domain in DOMAINS if domain in reports],
        "pending_file_domains": [domain for domain in DOMAINS if domain in REPORT_DOMAINS and domain not in reports],
        "reports": {domain: compact_report(reports[domain]) for domain in DOMAINS if domain in reports},
        "closure_status": {row["domain"]: row["readiness"] for row in template["domains"]},
        "does_not_authorize": ["G0-09", "Scope#9", "G0-signature", "Ddev", "code-development", "database-write"],
    }


def write_workpack(template: dict[str, Any], workpack: dict[str, Any], output_dir: Path) -> Path:
    output_dir = output_dir.expanduser().resolve()
    if output_dir.exists() and any(output_dir.iterdir()):
        raise FileExistsError(f"输出目录非空，拒绝覆盖：{output_dir}")
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}-", dir=output_dir.parent))
    try:
        (temp_dir / "closure_manifest.json").write_text(
            json.dumps(template, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        (temp_dir / "technical_prefill.json").write_text(
            json.dumps(workpack, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        report_map = workpack.get("reports", {})
        (temp_dir / "NEXT_STEPS.md").write_text(next_steps(template, report_map), encoding="utf-8")
        os.replace(temp_dir, output_dir)
        return output_dir
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="生成客服 Agent G0-09 仓外待签工作包")
    parser.add_argument("--template", required=True)
    parser.add_argument("--presale-report")
    parser.add_argument("--aftersale-report")
    parser.add_argument("--output-dir", required=True)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    template = read_json(Path(args.template))
    reports: dict[str, dict[str, Any]] = {}
    if args.presale_report:
        reports["presale"] = read_json(Path(args.presale_report))
    if args.aftersale_report:
        reports["aftersale"] = read_json(Path(args.aftersale_report))
    workpack = build_workpack(template, reports)
    output = write_workpack(template, workpack, Path(args.output_dir))
    print(json.dumps({
        "status": workpack["status"],
        "received_domains": workpack["received_domains"],
        "output_dir": str(output),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
