import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from run_customer_agent_g009_intake import REPO_ROOT, run_intake


def write_template(path: Path) -> None:
    rows = []
    for domain in ("presale", "campaign", "aftersale", "product"):
        rows.append({"domain": domain, "readiness": "INCOMPLETE"})
    path.write_text(json.dumps({"schemaVersion": 1, "evidenceId": "", "domains": rows}), encoding="utf-8")


def write_source(path: Path) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["产品", "客户问题", "标准话术", "状态"])
        writer.writerow(["示例", "如何使用", "示例回答", "启用"])


class IntakeRunnerTest(unittest.TestCase):
    def test_two_domains_produce_atomic_workpack(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            template = root_path / "template.json"
            presale = root_path / "presale.csv"
            aftersale = root_path / "aftersale.csv"
            output = root_path / "workpack"
            write_template(template)
            write_source(presale)
            write_source(aftersale)
            result = run_intake(template, output, presale, aftersale)
            self.assertEqual(result["received_domains"], ["presale", "aftersale"])
            self.assertEqual(result["pending_file_domains"], [])
            self.assertEqual(sorted(path.name for path in output.iterdir()), [
                "NEXT_STEPS.md", "closure_manifest.json", "technical_prefill.json",
            ])
            technical = (output / "technical_prefill.json").read_text(encoding="utf-8")
            self.assertNotIn("示例回答", technical)
            self.assertNotIn("presale.csv", technical)
            self.assertEqual(result["next_step"]["command"], "npm")
            self.assertIn("--require-ready", result["next_step"]["args"])
            self.assertTrue(any("closure_manifest.json" in arg for arg in result["next_step"]["args"]))

    def test_single_domain_is_allowed_and_other_remains_pending(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            template = root_path / "template.json"
            source = root_path / "source.csv"
            write_template(template)
            write_source(source)
            result = run_intake(template, root_path / "workpack", presale_file=source)
            self.assertEqual(result["received_domains"], ["presale"])
            self.assertEqual(result["pending_file_domains"], ["aftersale"])
            self.assertEqual(set(result["closure_status"].values()), {"INCOMPLETE"})

    def test_failure_leaves_no_partial_output_and_repo_boundary_is_enforced(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            template = root_path / "template.json"
            bad_source = root_path / "source.txt"
            output = root_path / "workpack"
            write_template(template)
            bad_source.write_text("bad", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "xlsx"):
                run_intake(template, output, presale_file=bad_source)
            self.assertFalse(output.exists())

        with self.assertRaisesRegex(ValueError, "output/"):
            run_intake(
                REPO_ROOT / "business-docs/08-工具/templates/customer-agent-g009-intake.template.json",
                REPO_ROOT / "business-docs/unsafe-g009-output",
                presale_file=REPO_ROOT / "README.md",
            )


if __name__ == "__main__":
    unittest.main()
