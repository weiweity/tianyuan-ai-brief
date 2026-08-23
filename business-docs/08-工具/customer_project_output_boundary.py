#!/usr/bin/env python3
"""客服项目 Python 工具共享的输出边界与受控目录发布。

公开仓内只允许写入已忽略的 ``output/`` 子目录；仓外允许写入明确的
叶子目录。会递归替换内容的工具还必须验证由本模块写入的 managed marker，
避免把用户误填的任意目录当作工具产物删除。
"""

from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parents[2]
REPO_OUTPUT = (REPO_ROOT / "output").resolve()
MANAGED_OUTPUT_MARKER = ".customer-agent-managed-output.json"
MARKER_SCHEMA_VERSION = 1


def is_within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def validate_output_boundary(output_dir: Path) -> Path:
    """解析输出目录并拒绝公开仓越界、符号链接目标和宽泛根目录。"""

    requested = output_dir.expanduser()
    if requested.is_symlink():
        raise ValueError(f"输出目录不能是符号链接：{requested}")
    resolved = requested.resolve()
    home = Path.home().resolve()
    broad_targets = {
        Path("/").resolve(),
        home,
        (home / "Desktop").resolve(),
        (home / "Documents").resolve(),
        (home / "Downloads").resolve(),
        REPO_ROOT,
        REPO_OUTPUT,
    }
    if resolved in broad_targets:
        raise ValueError(f"拒绝把宽泛目录作为客服工具输出：{resolved}")
    if is_within(resolved, REPO_ROOT) and not is_within(resolved, REPO_OUTPUT):
        raise ValueError("仓内输出只允许写入已忽略的 output/；也可选择仓外受控目录")
    if resolved.exists() and not resolved.is_dir():
        raise ValueError(f"输出目标已存在但不是目录：{resolved}")
    return resolved


def ensure_sources_outside_output(output_dir: Path, sources: Iterable[Path]) -> None:
    """防止输出替换覆盖输入文件或其所在子树。"""

    for source in sources:
        resolved_source = source.expanduser().resolve()
        if is_within(resolved_source, output_dir):
            raise ValueError(f"输入文件不能位于待替换输出目录内：{resolved_source}")


def write_managed_marker(
    staging_dir: Path,
    *,
    kind: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    payload = {
        "schema_version": MARKER_SCHEMA_VERSION,
        "kind": kind,
        "managed_by": "customer_project_output_boundary.py",
        **(metadata or {}),
    }
    (staging_dir / MANAGED_OUTPUT_MARKER).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _assert_managed_directory(output_dir: Path, expected_kind: str) -> None:
    marker_path = output_dir / MANAGED_OUTPUT_MARKER
    if marker_path.is_symlink() or not marker_path.is_file():
        raise ValueError(
            f"拒绝覆盖非本工具管理的目录；缺少安全 marker：{marker_path}"
        )
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"输出目录安全 marker 无效：{marker_path}") from exc
    if (
        marker.get("schema_version") != MARKER_SCHEMA_VERSION
        or marker.get("kind") != expected_kind
        or marker.get("managed_by") != "customer_project_output_boundary.py"
    ):
        raise ValueError(f"输出目录安全 marker 与当前工具不匹配：{marker_path}")


def publish_managed_directory(
    staging_dir: Path,
    output_dir: Path,
    *,
    kind: str,
    overwrite: bool,
) -> None:
    """把完整 staging 原子发布；只替换带匹配 marker 的既有非空目录。"""

    backup_dir: Path | None = None
    if output_dir.exists():
        entries = list(output_dir.iterdir())
        if entries:
            if not overwrite:
                raise FileExistsError(
                    f"输出目录已有文件，若确认替换本工具产物请加 --overwrite：{output_dir}"
                )
            _assert_managed_directory(output_dir, kind)
            backup_dir = output_dir.with_name(
                f".{output_dir.name}.backup-{uuid.uuid4().hex}"
            )
            output_dir.rename(backup_dir)
        else:
            output_dir.rmdir()
    try:
        staging_dir.rename(output_dir)
    except Exception:
        if backup_dir is not None and backup_dir.exists() and not output_dir.exists():
            backup_dir.rename(output_dir)
        raise
    if backup_dir is not None:
        shutil.rmtree(backup_dir)
