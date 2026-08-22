import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from inspect_customer_agent_source import inspect_source, write_report


class SourceInspectorTest(unittest.TestCase):
    def test_csv_report_contains_only_safe_structure(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "真实售前话术.csv"
            with source.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(["产品", "客户问题", "标准话术", "状态"])
                writer.writerow(["示例商品", "联系 13800138000", "查看 https://example.invalid", "启用"])
            report = inspect_source(source, "presale")
            serialized = json.dumps(report, ensure_ascii=False)
            self.assertEqual(report["status"], "TECHNICAL_PREFILL")
            self.assertEqual(report["sheet_count"], 1)
            self.assertIn("question_text", report["sheets"][0]["recognized_fields"])
            self.assertEqual(report["sensitive_hit_counts"]["phone"], 1)
            self.assertEqual(report["sensitive_hit_counts"]["url"], 1)
            self.assertNotIn("真实售前话术", serialized)
            self.assertNotIn("13800138000", serialized)
            self.assertNotIn("example.invalid", serialized)

    def test_output_is_non_overwriting_and_atomic(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "report"
            report = {"status": "TECHNICAL_PREFILL"}
            path = write_report(report, output)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), report)
            with self.assertRaises(FileExistsError):
                write_report(report, output)

    def test_rejects_unknown_domain_and_suffix(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source.txt"
            source.write_text("data", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "domain"):
                inspect_source(source, "product")
            with self.assertRaisesRegex(ValueError, "xlsx"):
                inspect_source(source, "presale")


if __name__ == "__main__":
    unittest.main()
