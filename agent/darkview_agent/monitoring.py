"""ADR-064: errors are reported to Sentry, scrubbed, and only when configured.

The agent logs every failure through `logging`; Sentry's logging integration turns an
ERROR record (and `logger.exception`) into an event. Nothing is sent unless
`SENTRY_DSN` is set, and nothing that identifies a person or unlocks the observatory
leaves this process: the device token, emails, bearer values, long hex or base64 runs.
"""

from __future__ import annotations

import re
from typing import Any

SCRUBBED = "[scrubbed]"

_SECRET_KEY = re.compile(
    r"token|password|passwd|secret|key|code|signature|session|cookie|authorization|email|phone",
    re.IGNORECASE,
)
_BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_SECRET_PAIR = re.compile(
    r"\b([\w-]*(?:token|password|passwd|secret|key|code|signature|session|cookie|authorization)"
    r"[\w-]*)([\"']?\s*[:=]\s*[\"']?)([^\s\"'&,;}]+)",
    re.IGNORECASE,
)
_PATTERNS = (
    re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE),
    re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"),
    re.compile(r"\b[A-Fa-f0-9]{32,}\b"),
    re.compile(r"[A-Za-z0-9+_-]{40,}={0,2}"),
)


def scrub_text(text: str) -> str:
    out = _BEARER.sub(SCRUBBED, text)
    out = _SECRET_PAIR.sub(lambda match: f"{match.group(1)}{match.group(2)}{SCRUBBED}", out)
    for pattern in _PATTERNS:
        out = pattern.sub(SCRUBBED, out)
    return out


def scrub_value(value: Any, depth: int = 0) -> Any:
    if isinstance(value, str):
        return scrub_text(value)
    if depth > 6:
        return SCRUBBED
    if isinstance(value, dict):
        return {
            key: SCRUBBED if _SECRET_KEY.search(str(key)) else scrub_value(item, depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [scrub_value(item, depth + 1) for item in value]
    return value


def scrub_event(event: dict[str, Any], _hint: dict[str, Any] | None = None) -> dict[str, Any]:
    event.pop("user", None)
    event.pop("server_name", None)
    event.pop("request", None)
    if isinstance(event.get("message"), str):
        event["message"] = scrub_text(event["message"])
    logentry = event.get("logentry")
    if isinstance(logentry, dict):
        event["logentry"] = scrub_value(logentry)
    for exception in (event.get("exception") or {}).get("values") or []:
        if isinstance(exception.get("value"), str):
            exception["value"] = scrub_text(exception["value"])
    breadcrumbs = event.get("breadcrumbs")
    if isinstance(breadcrumbs, dict) and isinstance(breadcrumbs.get("values"), list):
        breadcrumbs["values"] = [scrub_breadcrumb(crumb) for crumb in breadcrumbs["values"]]
    for field in ("extra", "contexts", "tags"):
        if field in event:
            event[field] = scrub_value(event[field])
    return event


def scrub_breadcrumb(crumb: dict[str, Any], _hint: dict[str, Any] | None = None) -> dict[str, Any]:
    if isinstance(crumb.get("message"), str):
        crumb["message"] = scrub_text(crumb["message"])
    if "data" in crumb:
        crumb["data"] = scrub_value(crumb["data"])
    return crumb


def start_monitoring(environment: dict[str, str]) -> bool:
    """Start Sentry when `SENTRY_DSN` is set. Returns whether it started."""
    dsn = environment.get("SENTRY_DSN", "").strip()
    if not dsn:
        return False

    import sentry_sdk

    sentry_sdk.init(
        dsn=dsn,
        environment=environment.get("SENTRY_ENVIRONMENT", "").strip() or "development",
        send_default_pii=False,
        # A frame's locals would carry the device token and the config.
        include_local_variables=False,
        traces_sample_rate=0,
        before_send=scrub_event,
        before_breadcrumb=scrub_breadcrumb,
    )
    return True
