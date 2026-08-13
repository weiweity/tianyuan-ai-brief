#!/usr/bin/env python3
"""客服 staging API 原型的标准库合同测试。"""

from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from customer_service_staging_api import StagingHTTPServer, StagingStore


class StagingApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="customer-service-staging-api-")
        root = Path(self.temp_dir.name)
        self.batch_id = "BATCH-API-TEST-001"
        (root / "batch_manifest.json").write_text(
            json.dumps(
                {
                    "batch_id": self.batch_id,
                    "generated_at": "2026-08-12T00:00:00+08:00",
                    "data_status": "prefill",
                    "preview_limit_per_sheet": 1000,
                    "output_records": {"qa": 1, "campaign": 0, "voc": 0},
                    "source_files": [],
                    "postgresql_written": False,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        (root / "quality_report.json").write_text("{}", encoding="utf-8")
        record = {
            "import_batch_id": self.batch_id,
            "data_status": "prefill",
            "record_id": "QA-PREVIEW-000001",
            "record_type": "qa_answer",
            "question_text": "适合什么肤质？",
            "approved_script": "适合多类肤质，具体以人工复核为准。",
            "processing_status": "待复核",
        }
        (root / "qa.jsonl").write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")
        (root / "campaign.jsonl").write_text("", encoding="utf-8")
        (root / "voc.jsonl").write_text("", encoding="utf-8")
        self.store = StagingStore(root)
        self.server = StagingHTTPServer(("127.0.0.1", 0), self.store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp_dir.cleanup()

    def request(self, method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        body = None
        headers = {}
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        data = json.loads(response.read().decode("utf-8"))
        connection.close()
        return response.status, data

    def test_health_and_records_are_read_only(self) -> None:
        status, body = self.request("GET", "/healthz")
        self.assertEqual(status, 200)
        self.assertFalse(body["postgresql_written"])

        status, body = self.request("GET", f"/batches/{self.batch_id}/records?type=qa&limit=10")
        self.assertEqual(status, 200)
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["records"][0]["data_status"], "prefill")

        status, body = self.request("GET", "/batches/../batch_manifest.json")
        self.assertEqual(status, 400)
        self.assertFalse(body["ok"])

    def test_review_requires_evidence_and_keeps_prefill(self) -> None:
        base = {
            "record_type": "qa",
            "record_id": "QA-PREVIEW-000001",
            "decision": "confirm",
            "reviewer_role": "ROLE-QA-001",
            "evidence_id": "EVD-G0-13-REVIEW-20260812",
            "idempotency_key": "REVKEY-API-001",
        }
        status, body = self.request("POST", f"/batches/{self.batch_id}/reviews", base)
        self.assertEqual(status, 201)
        self.assertFalse(body["review"]["promote_to_official"])
        self.assertTrue(body["review"]["prefill_unchanged"])

        status, body = self.request("POST", f"/batches/{self.batch_id}/reviews", base)
        self.assertEqual(status, 200)
        self.assertTrue(body["duplicate"])

        status, body = self.request(
            "POST",
            f"/batches/{self.batch_id}/reviews",
            {"record_type": "qa", "record_id": "QA-PREVIEW-000001", "decision": "confirm", "reviewer_role": "ROLE-QA-001"},
        )
        self.assertEqual(status, 400)
        self.assertIn("EVD", body["error"])

        status, body = self.request("GET", f"/batches/{self.batch_id}/reviews?record_id=QA-PREVIEW-000001")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["reviews"]), 1)


if __name__ == "__main__":
    unittest.main()
