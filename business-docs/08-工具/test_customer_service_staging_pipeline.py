#!/usr/bin/env python3
"""客服 staging importer → loader 的安全与端到端合同测试。"""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from openpyxl import Workbook

import customer_service_staging_loader as loader
from customer_project_output_boundary import MANAGED_OUTPUT_MARKER
from customer_service_staging_contract import scrub_text
from customer_service_staging_importer import build_batch


def write_workbook(path: Path, title: str, rows: list[list[object]]) -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = title
    for row in rows:
        sheet.append(row)
    workbook.save(path)
    workbook.close()


def source_files(root: Path) -> tuple[Path, Path, Path]:
    qa = root / "qa.xlsx"
    campaign = root / "campaign.xlsx"
    voc = root / "voc.xlsx"
    write_workbook(
        qa,
        "产品QA",
        [
            ["产品", "问题", "回答", "话术"],
            ["示例面膜", "联系 13800138000 / qa@example.test", "人工复核", "示例话术"],
        ],
    )
    write_workbook(
        campaign,
        "活动话术",
        [
            ["登记日期", "分组", "快捷编码", "快捷短语", "是否加入团队"],
            ["2026-08-23", "活动", "PROMO-1", "示例活动话术", "否"],
        ],
    )
    write_workbook(
        voc,
        "面膜类料体问题明细",
        [
            ["日期", "订单", "一级", "二级", "三级", "产品", "描述", "图片", "批次", "客户备注", "四级"],
            ["2026-08-23", "ORDER-RAW", "商品问题", "料体", "异物", "示例面膜", "身份证 11010519491231002X", "查看", "B-1", "邮箱 voc@example.test", ""],
        ],
    )
    return qa, campaign, voc


def importer_args(
    qa: Path,
    campaign: Path,
    voc: Path,
    output: Path,
    *,
    overwrite: bool = False,
) -> SimpleNamespace:
    return SimpleNamespace(
        qa_file=str(qa),
        campaign_file=str(campaign),
        voc_file=str(voc),
        output_dir=str(output),
        batch_id="BATCH-PIPELINE-TEST-001",
        max_rows_per_sheet=20,
        overwrite=overwrite,
    )


class StagingPipelineTest(unittest.TestCase):
    def test_identifier_scrubbing_is_high_confidence_and_explicit(self) -> None:
        scrubbed = scrub_text(
            "手机 13800138000；邮箱 qa@example.test；身份证 11010519491231002X；https://example.test"
        )
        self.assertEqual(
            scrubbed,
            "手机 [PHONE_REDACTED]；邮箱 [EMAIL_REDACTED]；身份证 [ID_REDACTED]；[URL_REDACTED]",
        )

    def test_importer_loader_contract_preserves_source_size_and_managed_boundary(self) -> None:
        with tempfile.TemporaryDirectory(prefix="customer-staging-pipeline-") as root:
            root_path = Path(root)
            qa, campaign, voc = source_files(root_path)
            output = root_path / "controlled" / "batch"
            manifest = build_batch(importer_args(qa, campaign, voc, output))

            self.assertTrue((output / MANAGED_OUTPUT_MARKER).is_file())
            self.assertTrue(all(source["source_size_bytes"] > 0 for source in manifest["source_files"]))
            self.assertTrue(all("file_size_bytes" not in source for source in manifest["source_files"]))
            qa_record = json.loads((output / "qa.jsonl").read_text(encoding="utf-8").splitlines()[0])
            self.assertNotIn("13800138000", json.dumps(qa_record, ensure_ascii=False))
            self.assertNotIn("qa@example.test", json.dumps(qa_record, ensure_ascii=False))

            loaded_manifest, rows = loader.validate_batch(output)
            sql = loader.build_sql(
                loaded_manifest,
                rows,
                loader.SCHEMA_FILE.read_text(encoding="utf-8"),
            )
            source_values = next(
                line for line in sql.splitlines() if line.startswith("VALUES (") and "qa.xlsx" in line
            )
            self.assertNotIn("NULL", source_values)

            sql_out = output / "staging_load.sql"
            with patch.object(loader.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
                exit_code = loader.main(
                    [
                        "--staging-dir",
                        str(output),
                        "--sql-out",
                        str(sql_out),
                        "--apply",
                        "--pg-service",
                        "customer_agent_staging",
                    ]
                )
            self.assertEqual(exit_code, 0)
            command = run.call_args.args[0]
            options = run.call_args.kwargs
            self.assertIn("--set=ON_ERROR_STOP=1", command)
            self.assertIn("--no-password", command)
            self.assertNotIn("customer_agent_staging", command)
            self.assertFalse(any("postgresql://" in part for part in command))
            self.assertEqual(options["env"]["PGSERVICE"], "customer_agent_staging")
            self.assertTrue(options["capture_output"])
            self.assertTrue(options["check"])

            output_buffer = StringIO()
            with (
                patch.object(
                    loader.subprocess,
                    "run",
                    side_effect=subprocess.CalledProcessError(3, ["psql"]),
                ),
                redirect_stdout(output_buffer),
                self.assertRaises(subprocess.CalledProcessError),
            ):
                loader.main(
                    [
                        "--staging-dir",
                        str(output),
                        "--sql-out",
                        str(sql_out),
                        "--apply",
                        "--pg-service",
                        "customer_agent_staging",
                    ]
                )
            self.assertNotIn('"applied": true', output_buffer.getvalue())

            with self.assertRaisesRegex(SystemExit, "只允许与 --apply"):
                loader.main(
                    [
                        "--staging-dir",
                        str(output),
                        "--sql-out",
                        str(sql_out),
                        "--pg-service",
                        "customer_agent_staging",
                    ]
                )

            rebuilt = build_batch(importer_args(qa, campaign, voc, output, overwrite=True))
            self.assertEqual(rebuilt["batch_id"], manifest["batch_id"])
            self.assertTrue((output / MANAGED_OUTPUT_MARKER).is_file())
            self.assertFalse(sql_out.exists())

    def test_overwrite_refuses_unmanaged_directory_without_deleting_it(self) -> None:
        with tempfile.TemporaryDirectory(prefix="customer-staging-overwrite-") as root:
            root_path = Path(root)
            qa, campaign, voc = source_files(root_path)
            output = root_path / "unmanaged"
            output.mkdir()
            sentinel = output / "keep.txt"
            sentinel.write_text("keep", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "marker"):
                build_batch(importer_args(qa, campaign, voc, output, overwrite=True))
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")


if __name__ == "__main__":
    unittest.main()
