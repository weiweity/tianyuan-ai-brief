import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prepare_customer_agent_g009_workpack import build_workpack, write_workpack
from customer_project_output_boundary import REPO_ROOT


def template():
    rows = []
    for domain in ("presale", "campaign", "aftersale", "product"):
        rows.append({"domain": domain, "readiness": "INCOMPLETE"})
    return {"schemaVersion": 1, "evidenceId": "", "domains": rows}


def report(domain):
    return {
        "schema_version": 1,
        "status": "TECHNICAL_PREFILL",
        "domain": domain,
        "source": {"extension": ".xlsx", "size_bytes": 128, "sha256": "a" * 64},
        "sheet_count": 1,
        "sheets": [{
            "sheet_alias": "sheet_001", "total_rows": 3, "nonempty_rows": 2,
            "max_columns": 4, "header_candidate_row": 1,
            "recognized_fields": ["question_text", "answer_text"],
            "sensitive_hit_counts": {}, "scan_truncated": False,
        }],
        "sensitive_hit_counts": {},
        "does_not_authorize": ["G0-09", "Ddev"],
    }


class WorkpackTest(unittest.TestCase):
    def test_merges_two_reports_without_promoting_closure(self):
        result = build_workpack(template(), {
            "presale": report("presale"),
            "aftersale": report("aftersale"),
        })
        self.assertEqual(result["received_domains"], ["presale", "aftersale"])
        self.assertEqual(result["pending_file_domains"], [])
        self.assertEqual(set(result["closure_status"].values()), {"INCOMPLETE"})
        self.assertEqual(result["reports"]["presale"]["interpretation"], "FILE_RECEIVED_AND_PARSED_ONLY")

    def test_rejects_wrong_domain_or_missing_boundary(self):
        wrong = report("aftersale")
        with self.assertRaisesRegex(ValueError, "错域"):
            build_workpack(template(), {"presale": wrong})
        unsafe = report("presale")
        unsafe["does_not_authorize"] = []
        with self.assertRaisesRegex(ValueError, "不授权边界"):
            build_workpack(template(), {"presale": unsafe})

    def test_writes_three_files_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "workpack"
            source_template = template()
            result = build_workpack(source_template, {"presale": report("presale")})
            write_workpack(source_template, result, target)
            self.assertEqual(
                sorted(path.name for path in target.iterdir()),
                ["NEXT_STEPS.md", "closure_manifest.json", "technical_prefill.json"],
            )
            closure = json.loads((target / "closure_manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(closure, source_template)
            self.assertIn("不是 EVD", (target / "NEXT_STEPS.md").read_text(encoding="utf-8"))
            with self.assertRaises(FileExistsError):
                write_workpack(source_template, result, target)

        with self.assertRaisesRegex(ValueError, "output/"):
            write_workpack(
                template(),
                build_workpack(template(), {"presale": report("presale")}),
                REPO_ROOT / "business-docs/unsafe-direct-workpack-output",
            )


if __name__ == "__main__":
    unittest.main()
