#!/usr/bin/env python3
"""客服 staging 的高置信标识符遮罩与跨步骤合同。

这里只处理可确定识别的 URL、token、邮箱、中国大陆手机号和身份证号。
它不是完整匿名化或 DLP；输出仍必须留在受控私有目录或仓内 ignored output/。
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any


SOURCE_SIZE_FIELD = "source_size_bytes"

URL_RE = re.compile(r"(?i)(?:https?://|www\.)[^\s<>{}\[\]()\"']+")
TOKEN_RE = re.compile(
    r"(?i)(?:tenant_access_token|open_id|doc_token|wiki_token|file_token)\s*[=:]\s*[^\s,;]+"
)
EMAIL_RE = re.compile(r"(?i)(?<![\w.+-])[\w.+-]{1,64}@[a-z0-9.-]+\.[a-z]{2,}(?![\w.-])")
MOBILE_RE = re.compile(r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)")
NATIONAL_ID_RE = re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")

SENSITIVE_PATTERNS = (
    (URL_RE, "[URL_REDACTED]"),
    (TOKEN_RE, "[TOKEN_REDACTED]"),
    (EMAIL_RE, "[EMAIL_REDACTED]"),
    (MOBILE_RE, "[PHONE_REDACTED]"),
    (NATIONAL_ID_RE, "[ID_REDACTED]"),
)


def scrub_text(value: Any, limit: int = 1600) -> str:
    """转换成 staging 文本并遮罩高置信标识符。"""

    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).replace("\x00", "").strip()
    for pattern, replacement in SENSITIVE_PATTERNS:
        text = pattern.sub(replacement, text)
    if len(text) > limit:
        return text[:limit] + "…[TRUNCATED]"
    return text


def contains_high_confidence_identifier(value: str) -> bool:
    return any(pattern.search(value) for pattern, _ in SENSITIVE_PATTERNS)
