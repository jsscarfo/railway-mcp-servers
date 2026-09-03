"""Durable Tag Assistant + live gtm.js QA helpers for the GTM MCP.

No OAuth. inspect_live_gtm_js does one public HTTP GET. analyze_tag_assistant_export
reads a local Tag Assistant v2 JSON export only.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

SEND_TO_RE = re.compile(r"AW-\d+/[A-Za-z0-9_-]+")
CALENDLY_EVENT_RE = re.compile(r'calendly_event["\']?\s*:\s*["\']([^"\']+)["\']')
VALUE_RE = re.compile(r"\bvalue:\s*([0-9]+(?:\.[0-9]+)?)")
CURRENCY_RE = re.compile(r'currency:\s*["\']([^"\']+)["\']')
SEND_TO_FIELD_RE = re.compile(r'send_to:\s*["\']([^"\']+)["\']')
HTML_TAG_RE = re.compile(
    r'"function"\s*:\s*"__html".*?"vtp_html"\s*:\s*"(?P<html>(?:\\.|[^"\\])*)".*?"tag_id"\s*:\s*(?P<id>\d+)',
    re.DOTALL,
)
HTML_TAG_RE_ALT = re.compile(
    r'"function"\s*:\s*"__html".*?"tag_id"\s*:\s*(?P<id>\d+).*?"vtp_html"\s*:\s*"(?P<html>(?:\\.|[^"\\])*)"',
    re.DOTALL,
)
PAUSED_RE = re.compile(
    r'"function"\s*:\s*"__paused"[^}]*?"tag_id"\s*:\s*(\d+)',
    re.DOTALL,
)
PAUSED_ALT_RE = re.compile(
    r'"tag_id"\s*:\s*(\d+)[^}]*?"function"\s*:\s*"__paused"',
    re.DOTALL,
)
DEFAULT_NEEDLES = ("send_to", "AW-", "__paused", "gtag(")


def _as_list(value: Any) -> List[str]:
    if value is None or value == "":
        return []
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    if isinstance(value, (list, tuple)):
        return [str(part).strip() for part in value if str(part).strip()]
    return [str(value).strip()]


def _iso_from_timestamp(value: Any) -> str:
    try:
        ms = int(value)
    except (TypeError, ValueError):
        return ""
    if ms > 10_000_000_000:
        ms = ms / 1000.0
    return datetime.fromtimestamp(ms, tz=timezone.utc).isoformat()


def _consent_from(obj: Any) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not isinstance(obj, dict):
        return out
    items = obj.get("consentList") or obj.get("consent_list") or []
    if isinstance(items, dict):
        items = [items]
    for item in items:
        if not isinstance(item, dict):
            continue
        kind = item.get("type") or item.get("name")
        status = item.get("status") or item.get("value")
        if kind:
            out[str(kind)] = str(status or "")
    return out


def analyze_tag_assistant_export(
    file_path: str, expected_send_to: Any = None
) -> Dict[str, Any]:
    path = Path(file_path)
    if not path.is_file():
        return {"status": "error", "message": f"File not found: {file_path}"}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return {"status": "error", "message": f"Invalid JSON: {exc}"}
    except OSError as exc:
        return {"status": "error", "message": f"Could not read file: {exc}"}

    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return {"status": "error", "message": "Not a Tag Assistant v2 export (missing data)"}

    domain = data.get("domainDetails") or {}
    notes: List[str] = []
    conversions: List[Dict[str, Any]] = []
    calendly_counts: Counter[str] = Counter()
    whatsapp_click_count = 0
    containers_out: List[Dict[str, Any]] = []
    consent: Dict[str, str] = {}

    raw_containers = data.get("containers") or []
    if not isinstance(raw_containers, list):
        raw_containers = []

    for container in raw_containers:
        if not isinstance(container, dict):
            continue
        public_id = container.get("publicId") or ""
        product = container.get("product") or ""
        version = str(container.get("version") or "")
        details = container.get("containerDetails") or {}
        inner = details.get("container") if isinstance(details, dict) else {}
        preview = ""
        if isinstance(inner, dict):
            preview = str(inner.get("preview") or inner.get("environment") or "")
        if str(version).upper() == "QUICK_PREVIEW":
            notes.append("QUICK_PREVIEW — not a cold live hit")

        messages = container.get("messages") or []
        if not isinstance(messages, list):
            messages = []
        event_counts: Counter[str] = Counter()
        event_sequence: List[Dict[str, Any]] = []
        for message in messages:
            if not isinstance(message, dict):
                continue
            key = str(message.get("eventNameKey") or message.get("eventName") or "")
            if key:
                event_counts[key] += 1
            blob = str(message.get("messageString") or "")
            calendly_event = None
            match = CALENDLY_EVENT_RE.search(blob)
            if match:
                calendly_event = match.group(1)
                calendly_counts[calendly_event] += 1
            if "whatsapp_click" in key.lower() or "whatsapp_click" in blob.lower():
                whatsapp_click_count += 1
            seq: Dict[str, Any] = {
                "index": message.get("index"),
                "event": key,
            }
            if calendly_event:
                seq["calendly_event"] = calendly_event
            event_sequence.append(seq)
            consent_here = _consent_from(message.get("consentData"))
            if consent_here:
                consent = consent_here
            if key == "conversion":
                send_to = ""
                send_match = SEND_TO_FIELD_RE.search(blob)
                if send_match:
                    send_to = send_match.group(1)
                else:
                    found = SEND_TO_RE.findall(blob)
                    send_to = found[0] if found else ""
                value_match = VALUE_RE.search(blob)
                currency_match = CURRENCY_RE.search(blob)
                conversions.append(
                    {
                        "container_public_id": public_id,
                        "index": message.get("index"),
                        "send_to": send_to,
                        "value": float(value_match.group(1)) if value_match else None,
                        "currency": currency_match.group(1) if currency_match else None,
                    }
                )

        containers_out.append(
            {
                "public_id": public_id,
                "product": product,
                "version": version,
                "preview": preview,
                "event_counts": dict(event_counts),
                "event_sequence": event_sequence,
            }
        )

    notes = list(dict.fromkeys(notes))
    gtm_containers = [c for c in containers_out if str(c.get("product")).upper() == "GTM"]
    rollup_source = gtm_containers[0] if gtm_containers else (containers_out[0] if containers_out else None)
    if rollup_source is not None:
        calendly_counts = Counter()
        whatsapp_click_count = 0
        for item in rollup_source.get("event_sequence") or []:
            cal = item.get("calendly_event")
            if cal:
                calendly_counts[cal] += 1
            if "whatsapp_click" in str(item.get("event") or "").lower():
                whatsapp_click_count += 1
        gtm_id = rollup_source.get("public_id")
        conversions = [
            conv
            for conv in conversions
            if conv.get("container_public_id") == gtm_id
        ]

    expected_labels = _as_list(expected_send_to)
    expected_result = []
    if expected_labels:
        counts = Counter(item.get("send_to") for item in conversions if item.get("send_to"))
        for label in expected_labels:
            expected_result.append({"label": label, "count": int(counts.get(label, 0))})
    return {
        "status": "success",
        "start_url": domain.get("startUrl") or "",
        "timestamp_iso": _iso_from_timestamp(payload.get("timestamp") or domain.get("createdTime")),
        "containers_listed": domain.get("containers") or [],
        "containers": containers_out,
        "conversions": conversions,
        "calendly_event_counts": dict(calendly_counts),
        "whatsapp_click_count": whatsapp_click_count,
        "consent": consent,
        "expected_send_to_result": expected_result,
        "notes": notes,
    }


def _unescape_js_string(value: str) -> str:
    text = value.replace("\\/", "/")
    try:
        text = bytes(text, "utf-8").decode("unicode_escape")
    except Exception:
        text = text.replace("\\n", "\n").replace('\\"', '"')
    return text.replace("\\/", "/").replace('\\"', '"')


def _iter_html_tags(js: str) -> Iterable[Dict[str, Any]]:
    seen = set()
    for pattern in (HTML_TAG_RE, HTML_TAG_RE_ALT):
        for match in pattern.finditer(js):
            tag_id = match.group("id")
            if tag_id in seen:
                continue
            seen.add(tag_id)
            yield {
                "tag_id": int(tag_id),
                "html": _unescape_js_string(match.group("html")),
            }


def _paused_tag_ids(js: str) -> List[int]:
    ids = set()
    for pattern in (PAUSED_RE, PAUSED_ALT_RE):
        for match in pattern.finditer(js):
            ids.add(int(match.group(1)))
    return sorted(ids)


def inspect_live_gtm_js(public_id: str, needles: Any = None) -> Dict[str, Any]:
    container_id = (public_id or "").strip()
    if not container_id:
        return {"status": "error", "message": "public_id is required"}
    needle_list = _as_list(needles) or list(DEFAULT_NEEDLES)
    url = f"https://www.googletagmanager.com/gtm.js?id={container_id}"
    request = urllib.request.Request(url, headers={"User-Agent": "gtm-mcp-qa/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        return {"status": "error", "message": f"Network failure fetching {url}: {exc}"}
    except TimeoutError:
        return {"status": "error", "message": f"Network failure fetching {url}: timeout"}

    html_tags = []
    for tag in _iter_html_tags(body):
        html = tag["html"]
        hits = [needle for needle in needle_list if needle in html]
        html_tags.append(
            {
                "tag_id": tag["tag_id"],
                "has_tour_flag": "__fpxTourConversionFired" in html,
                "send_to_labels": sorted(set(SEND_TO_RE.findall(html))),
                "needle_hits": hits,
                "preview": html[:120],
            }
        )

    return {
        "status": "success",
        "public_id": container_id,
        "html_tag_count": len(html_tags),
        "paused_tag_ids": _paused_tag_ids(body),
        "html_tags": html_tags,
    }
