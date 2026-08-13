#!/usr/bin/env python3
"""客服 staging 的本地预览/人工审阅 API 原型。

这个服务故意不是客服 Agent API，也不是正式内容发布 API：

* 只读取 importer 生成的 ``batch_manifest.json`` 与三份 JSONL；
* ``POST /reviews`` 只追加人工审阅事件，不修改原始预填记录；
* 不连接 PostgreSQL，不写 ``content_releases`` / ``staging_scripts``，也不
  把 ``prefill`` 自动升级为 ``official``；
* 默认只绑定 127.0.0.1，适合在本机或受控跳板机上做第一轮核验。

运行示例：

  python3 customer_service_staging_api.py \
    --staging-dir output/customer-service-staging-code-20260812 \
    --port 8787

接口：``GET /healthz``、``GET /batches``、``GET /batches/{id}``、
``GET /batches/{id}/records?type=qa|campaign|voc``、
``GET /batches/{id}/reviews`` 和
``POST /batches/{id}/reviews``。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit


RECORD_FILES = {"qa": "qa.jsonl", "campaign": "campaign.jsonl", "voc": "voc.jsonl"}
RECORD_TYPES = frozenset(RECORD_FILES)
BATCH_ID_RE = re.compile(r"^[A-Z0-9][A-Z0-9._-]{0,127}$")
RECORD_ID_RE = re.compile(r"^[A-Z0-9][A-Z0-9._-]{0,159}$")
ROLE_RE = re.compile(r"^ROLE-[A-Z0-9][A-Z0-9._-]{0,95}$")
EVIDENCE_RE = re.compile(r"^EVD-[A-Z0-9][A-Z0-9._-]{0,126}$")
IDEMPOTENCY_RE = re.compile(r"^REVKEY-[A-Z0-9][A-Z0-9._-]{0,95}$")
DECISIONS = frozenset({"hold", "confirm", "reject"})
MAX_BODY_BYTES = 32 * 1024
MAX_NOTE_CHARS = 1000
MAX_LIMIT = 200


class StagingValidationError(ValueError):
    """输入批次或人工审阅请求不符合本地 staging 合同。"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _json_load(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise StagingValidationError(f"无法读取合法 JSON：{path.name}") from exc


def _safe_batch_id(value: str) -> str:
    if not BATCH_ID_RE.fullmatch(value):
        raise StagingValidationError("batch_id 格式不受控")
    return value


def _safe_record_type(value: Any) -> str:
    if not isinstance(value, str) or value not in RECORD_TYPES:
        raise StagingValidationError("record_type 必须是 qa、campaign 或 voc")
    return value


def _safe_record_id(value: Any) -> str:
    if not isinstance(value, str) or not RECORD_ID_RE.fullmatch(value):
        raise StagingValidationError("record_id 格式不受控")
    return value


def _safe_non_negative_int(value: str | None, name: str, default: int, upper: int) -> int:
    if value in (None, ""):
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise StagingValidationError(f"{name} 必须是整数") from exc
    if parsed < 0 or parsed > upper:
        raise StagingValidationError(f"{name} 超出允许范围")
    return parsed


class StagingStore:
    """对一个 importer 输出目录提供只读记录和追加审阅事件。"""

    def __init__(self, staging_dir: str | os.PathLike[str]):
        root = Path(staging_dir).expanduser()
        if root.is_symlink():
            raise StagingValidationError("staging 目录不能是符号链接")
        self.root = root.resolve()
        if not self.root.is_dir():
            raise StagingValidationError(f"staging 目录不存在：{self.root}")
        self.manifest_path = self.root / "batch_manifest.json"
        self.manifest = _json_load(self.manifest_path)
        if not isinstance(self.manifest, dict):
            raise StagingValidationError("batch_manifest.json 必须是对象")
        self.batch_id = _safe_batch_id(str(self.manifest.get("batch_id", "")))
        if self.manifest.get("data_status") != "prefill":
            raise StagingValidationError("本地 API 只接受 data_status=prefill 的批次")
        if self.manifest.get("postgresql_written") is True:
            raise StagingValidationError("批次已标记为 postgresql_written，拒绝作为预填批次打开")
        self._write_lock = threading.Lock()

    def _file(self, name: str) -> Path:
        path = self.root / name
        if path.parent != self.root or path.is_symlink() or not path.is_file():
            raise StagingValidationError(f"staging 文件不可安全读取：{name}")
        return path

    def _records(self, record_type: str) -> list[dict[str, Any]]:
        record_type = _safe_record_type(record_type)
        path = self._file(RECORD_FILES[record_type])
        rows: list[dict[str, Any]] = []
        with path.open(encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise StagingValidationError(f"{path.name}:{line_number} 不是合法 JSONL") from exc
                if not isinstance(row, dict):
                    raise StagingValidationError(f"{path.name}:{line_number} 必须是对象")
                if row.get("import_batch_id") != self.batch_id:
                    raise StagingValidationError(f"{path.name}:{line_number} 批次号不一致")
                if row.get("data_status") != "prefill":
                    raise StagingValidationError(f"{path.name}:{line_number} 不是 prefill")
                rows.append(row)
        return rows

    def _reviews_path(self) -> Path:
        path = self.root / "review_events.jsonl"
        if path.exists() and path.is_symlink():
            raise StagingValidationError("review_events.jsonl 不能是符号链接")
        return path

    def reviews(self, record_id: str | None = None) -> list[dict[str, Any]]:
        path = self._reviews_path()
        if not path.exists():
            return []
        rows: list[dict[str, Any]] = []
        with path.open(encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise StagingValidationError(f"review_events.jsonl:{line_number} 不是合法 JSONL") from exc
                if isinstance(row, dict) and row.get("batch_id") == self.batch_id:
                    if record_id is None or row.get("record_id") == record_id:
                        rows.append(row)
        return rows

    def summary(self) -> dict[str, Any]:
        counts = self.manifest.get("output_records", {})
        return {
            "batch_id": self.batch_id,
            "data_status": "prefill",
            "generated_at": self.manifest.get("generated_at", ""),
            "preview_limit_per_sheet": self.manifest.get("preview_limit_per_sheet", ""),
            "source_files": self.manifest.get("source_files", []),
            "output_records": {key: int(counts.get(key, 0)) for key in RECORD_TYPES},
            "review_event_count": len(self.reviews()),
            "postgresql_written": False,
            "official_promotion_required": True,
        }

    def records(self, record_type: str, limit: int, offset: int, status: str | None = None) -> dict[str, Any]:
        rows = self._records(record_type)
        if status:
            rows = [row for row in rows if row.get("processing_status") == status]
        page = rows[offset : offset + limit]
        return {
            "batch_id": self.batch_id,
            "record_type": record_type,
            "data_status": "prefill",
            "offset": offset,
            "limit": limit,
            "total": len(rows),
            "records": page,
            "postgresql_written": False,
        }

    def append_review(self, payload: Any) -> tuple[dict[str, Any], bool]:
        if not isinstance(payload, dict):
            raise StagingValidationError("请求体必须是 JSON 对象")
        record_type = _safe_record_type(payload.get("record_type"))
        record_id = _safe_record_id(payload.get("record_id"))
        decision = payload.get("decision")
        if decision not in DECISIONS:
            raise StagingValidationError("decision 必须是 hold、confirm 或 reject")
        reviewer_role = payload.get("reviewer_role")
        if not isinstance(reviewer_role, str) or not ROLE_RE.fullmatch(reviewer_role):
            raise StagingValidationError("reviewer_role 必须是 ROLE-* 代号")
        evidence_id = payload.get("evidence_id", "")
        if decision in {"confirm", "reject"}:
            if not isinstance(evidence_id, str) or not EVIDENCE_RE.fullmatch(evidence_id):
                raise StagingValidationError("confirm/reject 必须提供 EVD-* evidence_id")
        elif evidence_id not in ("", None):
            if not isinstance(evidence_id, str) or not EVIDENCE_RE.fullmatch(evidence_id):
                raise StagingValidationError("evidence_id 必须是 EVD-* 代号")
        note = payload.get("note", "")
        if not isinstance(note, str) or len(note) > MAX_NOTE_CHARS:
            raise StagingValidationError("note 必须是最多 1000 字的文本")
        idempotency_key = payload.get("idempotency_key", "")
        if idempotency_key and (not isinstance(idempotency_key, str) or not IDEMPOTENCY_RE.fullmatch(idempotency_key)):
            raise StagingValidationError("idempotency_key 必须是 REVKEY-* 代号")

        existing = self._records(record_type)
        if not any(row.get("record_id") == record_id for row in existing):
            raise StagingValidationError("record_id 不属于指定批次或记录类型")

        with self._write_lock:
            for event in self.reviews():
                if idempotency_key and event.get("idempotency_key") == idempotency_key:
                    return event, True
            event = {
                "review_id": f"REV-{uuid.uuid4().hex.upper()}",
                "batch_id": self.batch_id,
                "record_type": record_type,
                "record_id": record_id,
                "decision": decision,
                "reviewer_role": reviewer_role,
                "evidence_id": evidence_id or "",
                "note": note.strip(),
                "idempotency_key": idempotency_key or "",
                "created_at": utc_now(),
                "record_data_status": "prefill",
                "prefill_unchanged": True,
                "promote_to_official": False,
                "postgresql_written": False,
            }
            path = self._reviews_path()
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            return event, False


class StagingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: StagingStore):
        self.store = store
        super().__init__(address, StagingRequestHandler)


class StagingRequestHandler(BaseHTTPRequestHandler):
    server: StagingHTTPServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        # 默认不把用户数据/查询参数写入终端日志。
        sys.stderr.write("staging-api: " + format % args + "\n")

    def _send(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: HTTPStatus, message: str) -> None:
        self._send(status, {"ok": False, "error": message})

    @property
    def store(self) -> StagingStore:
        return self.server.store

    def _route(self) -> tuple[list[str], dict[str, list[str]]]:
        parsed = urlsplit(self.path)
        parts = [unquote(part) for part in parsed.path.split("/") if part]
        return parts, parse_qs(parsed.query, keep_blank_values=True)

    def do_GET(self) -> None:  # noqa: N802
        try:
            parts, query = self._route()
            if parts == ["healthz"]:
                self._send(HTTPStatus.OK, {"ok": True, "service": "customer-service-staging-api", "mode": "local-readonly-prototype", "postgresql_written": False})
                return
            if parts == ["batches"]:
                self._send(HTTPStatus.OK, {"ok": True, "batches": [self.store.summary()]})
                return
            if len(parts) < 2 or parts[0] != "batches":
                self._error(HTTPStatus.NOT_FOUND, "接口不存在")
                return
            batch_id = _safe_batch_id(parts[1])
            if batch_id != self.store.batch_id:
                self._error(HTTPStatus.NOT_FOUND, "批次不存在")
                return
            if len(parts) == 2:
                self._send(HTTPStatus.OK, {"ok": True, "batch": self.store.summary()})
                return
            if len(parts) != 3:
                self._error(HTTPStatus.NOT_FOUND, "接口不存在")
                return
            if parts[2] == "records":
                record_type = (query.get("type") or [""])[0]
                limit = _safe_non_negative_int((query.get("limit") or [None])[0], "limit", 50, MAX_LIMIT)
                if limit == 0:
                    raise StagingValidationError("limit 必须大于 0")
                offset = _safe_non_negative_int((query.get("offset") or [None])[0], "offset", 0, 10_000_000)
                status = (query.get("status") or [""])[0].strip()
                result = self.store.records(record_type, limit, offset, status or None)
                self._send(HTTPStatus.OK, {"ok": True, **result})
                return
            if parts[2] == "reviews":
                record_id = (query.get("record_id") or [None])[0]
                if record_id:
                    record_id = _safe_record_id(record_id)
                self._send(HTTPStatus.OK, {"ok": True, "batch_id": batch_id, "reviews": self.store.reviews(record_id)})
                return
            self._error(HTTPStatus.NOT_FOUND, "接口不存在")
        except StagingValidationError as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:  # pragma: no cover - defensive HTTP boundary
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"staging API 内部错误：{exc}")

    def do_POST(self) -> None:  # noqa: N802
        try:
            parts, _ = self._route()
            if len(parts) != 3 or parts[0] != "batches" or parts[2] != "reviews":
                self._error(HTTPStatus.NOT_FOUND, "接口不存在")
                return
            batch_id = _safe_batch_id(parts[1])
            if batch_id != self.store.batch_id:
                self._error(HTTPStatus.NOT_FOUND, "批次不存在")
                return
            raw_length = self.headers.get("Content-Length", "")
            try:
                length = int(raw_length)
            except ValueError as exc:
                raise StagingValidationError("Content-Length 不合法") from exc
            if length < 0 or length > MAX_BODY_BYTES:
                raise StagingValidationError("请求体过大")
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise StagingValidationError("请求体必须是 UTF-8 JSON") from exc
            event, duplicate = self.store.append_review(payload)
            self._send(HTTPStatus.OK if duplicate else HTTPStatus.CREATED, {"ok": True, "duplicate": duplicate, "review": event, "promotion_required": True})
        except StagingValidationError as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:  # pragma: no cover - defensive HTTP boundary
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"staging API 内部错误：{exc}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="客服 staging 本地预览/人工审阅 API（不连接 PostgreSQL）")
    parser.add_argument("--staging-dir", required=False, help="importer 输出目录")
    parser.add_argument("--host", default="127.0.0.1", help="默认只监听本机回环地址")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--self-test", action="store_true", help="仅检查模块导入与合同常量")
    return parser.parse_args(argv)


def self_test() -> None:
    assert _safe_batch_id("BATCH-PREFILL-20260812-CODE")
    assert _safe_record_type("voc") == "voc"
    assert ROLE_RE.fullmatch("ROLE-CS-MANAGER")
    assert EVIDENCE_RE.fullmatch("EVD-G0-13-REVIEW-20260812")
    assert not BATCH_ID_RE.fullmatch("../escape")
    print("SELF_TEST_PASS")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.self_test:
        self_test()
        return 0
    if not args.staging_dir:
        raise SystemExit("需要 --staging-dir；或使用 --self-test")
    if args.host != "127.0.0.1" and args.host != "localhost":
        raise SystemExit("为避免意外暴露，host 只允许 127.0.0.1 或 localhost")
    if not 1 <= args.port <= 65535:
        raise SystemExit("port 必须在 1..65535")
    store = StagingStore(args.staging_dir)
    server = StagingHTTPServer(("127.0.0.1", args.port), store)
    print(json.dumps({"service": "customer-service-staging-api", "host": "127.0.0.1", "port": server.server_port, "batch_id": store.batch_id, "mode": "local-readonly-prototype", "postgresql_written": False}, ensure_ascii=False), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (StagingValidationError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
