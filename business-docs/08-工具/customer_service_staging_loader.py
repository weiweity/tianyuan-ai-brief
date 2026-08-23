#!/usr/bin/env python3
"""把 staging JSONL 生成 PostgreSQL SQL；默认 dry-run，不连接数据库。

默认行为：读取 importer 输出目录，检查批次/脱敏/字段完整性，并生成
``staging_load.sql``。只有显式 ``--apply --pg-service ...`` 才调用 psql；
数据库凭据只由 libpq service / pgpass 读取，不进入命令行参数或错误日志。
这条链只写 ``customer_service_staging`` 隔离 schema，不写正式内容发布表。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from customer_project_output_boundary import validate_output_boundary
from customer_service_staging_contract import (
    SOURCE_SIZE_FIELD,
    contains_high_confidence_identifier,
)


SCHEMA_FILE = Path(__file__).with_name("customer_service_staging_schema.sql")
REQUIRED_FILES = ("batch_manifest.json", "quality_report.json", "qa.jsonl", "campaign.jsonl", "voc.jsonl")
SOURCE_TYPES = frozenset({"product_qa", "campaign", "voc"})
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
PG_SERVICE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def sql_string(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def sql_array(value: Any) -> str:
    if value in (None, "", []):
        return "'{}'::text[]"
    values = value if isinstance(value, list) else [item for item in str(value).split("|") if item]
    escaped = ",".join('"' + str(item).replace('"', '\\"') + '"' for item in values)
    return "ARRAY[" + ",".join(sql_string(item) for item in values) + "]::text[]"


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path.name}:{line_number} 不是合法 JSONL") from exc
            if not isinstance(row, dict):
                raise ValueError(f"{path.name}:{line_number} 必须是对象")
            rows.append(row)
    return rows


def validate_batch(staging_dir: Path) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
    missing = [name for name in REQUIRED_FILES if not (staging_dir / name).is_file()]
    if missing:
        raise FileNotFoundError(f"staging 目录缺少：{', '.join(missing)}")
    manifest = json.loads((staging_dir / "batch_manifest.json").read_text(encoding="utf-8"))
    batch_id = manifest.get("batch_id")
    if not isinstance(batch_id, str) or not batch_id:
        raise ValueError("batch_manifest.json 缺少 batch_id")
    if manifest.get("data_status") != "prefill":
        raise ValueError("当前 loader 只接受 data_status=prefill 的 staging 批次")
    if manifest.get("postgresql_written") is True:
        raise ValueError("批次已标记 postgresql_written=true，拒绝重复写入")
    source_files = manifest.get("source_files")
    if not isinstance(source_files, list) or not source_files:
        raise ValueError("batch_manifest.json 缺少 source_files")
    seen_source_types: set[str] = set()
    for index, source in enumerate(source_files, start=1):
        if not isinstance(source, dict):
            raise ValueError(f"source_files[{index}] 必须是对象")
        source_type = source.get("source_type")
        if source_type not in SOURCE_TYPES:
            raise ValueError(f"source_files[{index}] source_type 不受控")
        if source_type in seen_source_types:
            raise ValueError(f"source_files[{index}] source_type 重复")
        seen_source_types.add(source_type)
        source_file_name = source.get("source_file_name")
        if (
            not isinstance(source_file_name, str)
            or not source_file_name
            or Path(source_file_name).name != source_file_name
        ):
            raise ValueError(
                f"source_files[{index}] source_file_name 必须是不含路径的非空文件名"
            )
        if not isinstance(source.get("source_sha256"), str) or not SHA256_RE.fullmatch(source["source_sha256"]):
            raise ValueError(f"source_files[{index}] source_sha256 无效")
        if type(source.get(SOURCE_SIZE_FIELD)) is not int or source[SOURCE_SIZE_FIELD] < 0:
            raise ValueError(f"source_files[{index}] {SOURCE_SIZE_FIELD} 必须是非负整数")
        if type(source.get("sheet_count")) is not int or source["sheet_count"] < 0:
            raise ValueError(f"source_files[{index}] sheet_count 必须是非负整数")
    if seen_source_types != SOURCE_TYPES:
        missing = ",".join(sorted(SOURCE_TYPES - seen_source_types))
        raise ValueError(f"batch_manifest.json source_files 缺少来源类型：{missing}")
    rows = {name.removesuffix(".jsonl"): read_jsonl(staging_dir / name) for name in REQUIRED_FILES if name.endswith(".jsonl")}
    for record_type, records in rows.items():
        ids: set[str] = set()
        for index, record in enumerate(records, start=1):
            if record.get("import_batch_id") != batch_id:
                raise ValueError(f"{record_type}.jsonl:{index} import_batch_id 不一致")
            if record.get("data_status") != "prefill":
                raise ValueError(f"{record_type}.jsonl:{index} data_status 不是 prefill")
            record_id = record.get("record_id")
            if not isinstance(record_id, str) or not record_id or record_id in ids:
                raise ValueError(f"{record_type}.jsonl:{index} record_id 缺失或重复")
            ids.add(record_id)
            encoded = json.dumps(record, ensure_ascii=False)
            if contains_high_confidence_identifier(encoded):
                raise ValueError(f"{record_type}.jsonl:{index} 命中未遮罩的高置信标识符")
    expected = manifest.get("output_records", {})
    for record_type, records in rows.items():
        if expected.get(record_type) != len(records):
            raise ValueError(f"{record_type}.jsonl 行数与 manifest 不一致")
    return manifest, rows


def values_for(table: str, record: dict[str, Any]) -> tuple[list[str], list[str]]:
    if table == "qa":
        columns = ["batch_id", "record_id", "data_status", "record_date", "product_family", "product_name", "question_text", "internal_answer", "approved_script", "processing_status", "review_evidence_id", "source_file_name", "source_sheet_name", "source_row_no"]
        return columns, [sql_string(record.get(key)) for key in ["import_batch_id", "record_id", "data_status", "record_date", "product_family", "product_name", "question_text", "internal_answer", "approved_script", "processing_status", "review_evidence_id", "source_file_name", "source_sheet_name", "source_row_no"]]
    if table == "campaign":
        columns = ["batch_id", "record_id", "data_status", "record_date", "group_name", "shortcut_code", "approved_script", "team_enabled", "processing_status", "review_evidence_id", "source_file_name", "source_sheet_name", "source_row_no"]
        return columns, [sql_string(record.get(key)) for key in ["import_batch_id", "record_id", "data_status", "record_date", "group_name", "shortcut_code", "approved_script", "team_enabled", "processing_status", "review_evidence_id", "source_file_name", "source_sheet_name", "source_row_no"]]
    columns = ["batch_id", "record_id", "data_status", "record_date", "product_family", "product_name", "order_id", "category_l1", "category_l2", "category_l3", "category_l4", "primary_issue", "issue_tags", "question_text", "batch_no", "description", "image_ref", "feedback_count", "escalation_level", "processing_status", "owner_team", "collaborating_teams", "reviewer_role", "review_evidence_id", "source_file_name", "source_sheet_name", "source_row_no"]
    keys = ["import_batch_id", "record_id", "data_status", "record_date", "product_family", "product_name", "order_id", "category_l1", "category_l2", "category_l3", "category_l4", "primary_issue", "issue_tags", "question_text", "batch_no", "description", "image_ref", "feedback_count", "escalation_level", "processing_status", "owner_team", "collaborating_teams", "reviewer_role", "review_evidence_id", "source_file_name", "source_sheet_name", "source_row_no"]
    values = [sql_array(record.get(key)) if key in ("issue_tags", "collaborating_teams") else sql_string(record.get(key)) for key in keys]
    return columns, values


def build_sql(manifest: dict[str, Any], rows: dict[str, list[dict[str, Any]]], schema_text: str) -> str:
    batch_id = manifest["batch_id"]
    counts = manifest["output_records"]
    lines = [
        "-- GENERATED BY customer_service_staging_loader.py",
        "-- DRY-RUN SQL: only customer_service_staging is touched; no content release/search tables.",
        "BEGIN;",
        "SET LOCAL statement_timeout = '120s';",
        schema_text.rstrip(),
        "",
        "INSERT INTO customer_service_staging.import_batches(batch_id, data_status, qa_record_count, campaign_record_count, voc_record_count, postgresql_written)",
        f"VALUES ({sql_string(batch_id)}, 'prefill', {counts['qa']}, {counts['campaign']}, {counts['voc']}, FALSE)",
        "ON CONFLICT (batch_id) DO NOTHING;",
    ]
    source_values = []
    for source in manifest.get("source_files", []):
        source_values.append(
            "(" + sql_string(batch_id) + ", "
            + ", ".join(sql_string(source.get(key)) for key in ["source_file_name", "source_type"]) + ", "
            + ", ".join(sql_string(source.get(key)) for key in ["source_sha256", SOURCE_SIZE_FIELD, "sheet_count"]) + ", TRUE)"
        )
    if source_values:
        lines.extend([
            "INSERT INTO customer_service_staging.batch_sources(batch_id, source_file_name, source_type, source_sha256, source_size_bytes, sheet_count, raw_file_unchanged)",
            "VALUES " + ",\n".join(source_values) + ";",
        ])
    for record_type, table in (("qa", "qa_records"), ("campaign", "campaign_records"), ("voc", "voc_records")):
        for record in rows[record_type]:
            columns, values = values_for(record_type, record)
            lines.append(
                f"INSERT INTO customer_service_staging.{table}({', '.join(columns)})\n"
                f"VALUES ({', '.join(values)})\n"
                "ON CONFLICT (batch_id, record_id) DO NOTHING;"
            )
    lines.extend(["COMMIT;", ""])
    return "\n".join(lines)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成或显式应用客服 staging SQL")
    parser.add_argument("--staging-dir", required=False)
    parser.add_argument("--sql-out", required=False)
    parser.add_argument("--schema-file", default=str(SCHEMA_FILE))
    parser.add_argument("--apply", action="store_true", help="显式调用 psql 写入隔离 staging schema")
    parser.add_argument("--pg-service", default=None, help="仅与 --apply 一起使用；凭据由 libpq service/pgpass 提供，不进入命令行")
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args(argv)


def build_psql_command(sql_out: Path) -> list[str]:
    return [
        "psql",
        "--no-psqlrc",
        "--no-password",
        "--set=ON_ERROR_STOP=1",
        "--file",
        str(sql_out),
    ]


def psql_environment(pg_service: str) -> dict[str, str]:
    if not PG_SERVICE_RE.fullmatch(pg_service):
        raise ValueError("--pg-service 只允许字母、数字、点、下划线和短横线")
    environment = os.environ.copy()
    environment["PGSERVICE"] = pg_service
    return environment


def self_test() -> None:
    assert sql_string("O'Reilly") == "'O''Reilly'"
    assert sql_array("商品问题|料体内部问题") == "ARRAY['商品问题','料体内部问题']::text[]"
    assert contains_high_confidence_identifier("https://example.test")
    assert not contains_high_confidence_identifier("[URL_REDACTED]")
    assert build_psql_command(Path("staging.sql"))[:4] == [
        "psql", "--no-psqlrc", "--no-password", "--set=ON_ERROR_STOP=1"
    ]
    assert psql_environment("customer_agent_staging")["PGSERVICE"] == "customer_agent_staging"
    print("SELF_TEST_PASS")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.self_test:
        self_test()
        return 0
    if not args.staging_dir or not args.sql_out:
        raise SystemExit("需要 --staging-dir 和 --sql-out；或使用 --self-test")
    if args.pg_service and not args.apply:
        raise SystemExit("--pg-service 只允许与 --apply 同时使用")
    if args.apply and not args.pg_service:
        raise SystemExit("--apply 必须同时提供 --pg-service；默认只生成 SQL，不连接数据库")
    staging_dir = validate_output_boundary(Path(args.staging_dir))
    schema_file = Path(args.schema_file).expanduser().resolve()
    manifest, rows = validate_batch(staging_dir)
    sql = build_sql(manifest, rows, schema_file.read_text(encoding="utf-8"))
    requested_sql_out = Path(args.sql_out).expanduser()
    if requested_sql_out.is_symlink():
        raise ValueError("SQL 输出文件不能是符号链接")
    sql_out = requested_sql_out.resolve()
    validate_output_boundary(sql_out.parent)
    sql_out.parent.mkdir(parents=True, exist_ok=True)
    sql_out.write_text(sql, encoding="utf-8")
    result = {"batch_id": manifest["batch_id"], "sql_out": str(sql_out), "records": {key: len(value) for key, value in rows.items()}, "applied": False}
    if args.apply:
        subprocess.run(
            build_psql_command(sql_out),
            check=True,
            capture_output=True,
            text=True,
            env=psql_environment(args.pg_service),
        )
        result["applied"] = True
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"ERROR: psql 执行失败（exit={exc.returncode}）；未确认 staging 已应用", file=sys.stderr)
        raise SystemExit(2) from exc
    except (FileNotFoundError, ValueError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
