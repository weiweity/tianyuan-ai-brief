#!/usr/bin/env python3
"""一键执行售前/售后只读检查并原子生成 G0-09 仓外工作包。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from inspect_customer_agent_source import inspect_source
from prepare_customer_agent_g009_workpack import build_workpack, read_json, write_workpack


REPO_ROOT = Path(__file__).resolve().parents[2]
REPO_OUTPUT = (REPO_ROOT / "output").resolve()


def is_within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def validate_output_boundary(output_dir: Path) -> Path:
    resolved = output_dir.expanduser().resolve()
    if is_within(resolved, REPO_ROOT) and not is_within(resolved, REPO_OUTPUT):
        raise ValueError("仓内输出只允许写入已忽略的 output/；也可选择仓外受控目录")
    return resolved


def run_intake(
    template_path: Path,
    output_dir: Path,
    presale_file: Path | None = None,
    aftersale_file: Path | None = None,
) -> dict[str, Any]:
    if presale_file is None and aftersale_file is None:
        raise ValueError("至少提供 --presale-file 或 --aftersale-file")
    output_dir = validate_output_boundary(output_dir)
    if output_dir.exists() and any(output_dir.iterdir()):
        raise FileExistsError(f"输出目录非空，拒绝覆盖：{output_dir}")

    template = read_json(template_path)
    reports: dict[str, dict[str, Any]] = {}
    if presale_file is not None:
        reports["presale"] = inspect_source(presale_file, "presale")
    if aftersale_file is not None:
        reports["aftersale"] = inspect_source(aftersale_file, "aftersale")
    workpack = build_workpack(template, reports)
    write_workpack(template, workpack, output_dir)
    return {
        "status": workpack["status"],
        "received_domains": workpack["received_domains"],
        "pending_file_domains": workpack["pending_file_domains"],
        "closure_status": workpack["closure_status"],
        "output_dir": str(output_dir),
        "next_step": {
            "command": "npm",
            "args": [
                "--prefix", "sites", "run", "preflight:customer-agent-g009", "--",
                f"--manifest={output_dir / 'closure_manifest.json'}", "--require-ready",
            ],
        },
        "does_not_authorize": workpack["does_not_authorize"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="一键接收客服 Agent 售前/售后来源文件")
    parser.add_argument(
        "--template",
        default=str(REPO_ROOT / "business-docs/08-工具/templates/customer-agent-g009-intake.template.json"),
    )
    parser.add_argument("--presale-file")
    parser.add_argument("--aftersale-file")
    parser.add_argument("--output-dir", required=True)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    result = run_intake(
        template_path=Path(args.template),
        output_dir=Path(args.output_dir),
        presale_file=Path(args.presale_file) if args.presale_file else None,
        aftersale_file=Path(args.aftersale_file) if args.aftersale_file else None,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
