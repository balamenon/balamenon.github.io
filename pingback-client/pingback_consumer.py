#!/usr/bin/env python3
"""Pull Cloudflare Queue pingbacks and append them to a private local text file."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


API_ROOT = "https://api.cloudflare.com/client/v4"
DEFAULT_INTERVAL_SECONDS = 20
MAX_RECORD_BYTES = 16 * 1024
ID_PATTERN = re.compile(r"^[0-9a-fA-F-]{36}$")
CONTROL_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]")


class ConsumerError(RuntimeError):
    pass


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConsumerError(f"Missing required environment variable: {name}")
    return value


def api_request(url: str, token: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "bala-pingback-consumer/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read(MAX_RECORD_BYTES * 25)
    except urllib.error.HTTPError as error:
        detail = error.read(512).decode("utf-8", errors="replace")
        raise ConsumerError(f"Cloudflare API returned HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise ConsumerError(f"Could not reach Cloudflare: {error.reason}") from error

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ConsumerError("Cloudflare API returned invalid JSON") from error

    if not isinstance(parsed, dict) or parsed.get("success") is not True:
        raise ConsumerError("Cloudflare API reported an unsuccessful request")
    result = parsed.get("result")
    if not isinstance(result, dict):
        raise ConsumerError("Cloudflare API response did not contain a result")
    return result


def clean_text(value: Any, *, single_line: bool, max_length: int) -> str:
    if not isinstance(value, str):
        return ""
    cleaned = CONTROL_PATTERN.sub("", value.replace("\r\n", "\n").replace("\r", "\n")).strip()
    if single_line:
        cleaned = " ".join(cleaned.split())
    return cleaned[:max_length]


def decode_body(body: Any) -> dict[str, Any]:
    if isinstance(body, dict):
        return body
    if isinstance(body, str):
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError as error:
            raise ConsumerError("Queue message body was not valid JSON") from error
        if isinstance(parsed, dict):
            return parsed
    raise ConsumerError("Queue message body was not an object")


def format_record(payload: dict[str, Any]) -> tuple[str, bytes]:
    pingback_id = clean_text(payload.get("pingbackId"), single_line=True, max_length=36)
    if not ID_PATTERN.fullmatch(pingback_id):
        raise ConsumerError("Queue message had an invalid pingback ID")

    received_at = clean_text(payload.get("receivedAt"), single_line=True, max_length=40)
    name = clean_text(payload.get("name"), single_line=True, max_length=80) or "Anonymous"
    reply_to = clean_text(payload.get("replyTo"), single_line=True, max_length=200) or "Not provided"
    message = clean_text(payload.get("message"), single_line=False, max_length=4000)
    if not message:
        raise ConsumerError("Queue message had no message text")

    record = (
        "\n--- Pingback ---\n"
        f"Pingback-ID: {pingback_id}\n"
        f"Received: {received_at}\n"
        f"From: {name}\n"
        f"Reply-To: {reply_to}\n\n"
        f"{message}\n"
        "--- End Pingback ---\n"
    ).encode("utf-8")
    if len(record) > MAX_RECORD_BYTES:
        raise ConsumerError("Formatted pingback exceeded the local size limit")
    return pingback_id, record


def already_appended(path: Path, pingback_id: str) -> bool:
    if not path.exists():
        return False
    marker = f"Pingback-ID: {pingback_id}\n".encode("utf-8")
    with path.open("rb") as handle:
        return marker in handle.read()


def append_private(path: Path, record: bytes) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    descriptor = os.open(path, flags, 0o600)
    try:
        current_mode = stat.S_IMODE(os.fstat(descriptor).st_mode)
        if current_mode & 0o077:
            os.fchmod(descriptor, 0o600)
        written = os.write(descriptor, record)
        if written != len(record):
            raise ConsumerError("The local append was incomplete")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def process_batch(api_base: str, token: str, output_path: Path) -> tuple[int, int]:
    result = api_request(
        f"{api_base}/messages/pull",
        token,
        {"batch_size": 20, "visibility_timeout_ms": 60_000},
    )
    messages = result.get("messages", [])
    if not isinstance(messages, list):
        raise ConsumerError("Cloudflare API returned an invalid message list")

    acknowledgements: list[dict[str, str]] = []
    retries: list[dict[str, Any]] = []
    appended = 0

    for envelope in messages:
        if not isinstance(envelope, dict) or not isinstance(envelope.get("lease_id"), str):
            continue
        lease_id = envelope["lease_id"]
        try:
            pingback_id, record = format_record(decode_body(envelope.get("body")))
            if not already_appended(output_path, pingback_id):
                append_private(output_path, record)
                appended += 1
            acknowledgements.append({"lease_id": lease_id})
        except (ConsumerError, OSError) as error:
            print(f"Could not save queue message: {error}", file=sys.stderr)
            retries.append({"lease_id": lease_id, "delay_seconds": 60})

    if acknowledgements or retries:
        api_request(
            f"{api_base}/messages/ack",
            token,
            {"acks": acknowledgements, "retries": retries},
        )

    return appended, int(result.get("message_backlog_count") or 0)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Pull one batch and exit")
    parser.add_argument(
        "--interval",
        type=int,
        default=DEFAULT_INTERVAL_SECONDS,
        help=f"Seconds between polls (default: {DEFAULT_INTERVAL_SECONDS})",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.interval < 5:
        raise ConsumerError("Poll interval must be at least 5 seconds")

    account_id = required_env("CF_ACCOUNT_ID")
    queue_id = required_env("CF_QUEUE_ID")
    token = required_env("CF_QUEUES_API_TOKEN")
    configured_output = os.environ.get("PINGBACK_OUTPUT_PATH", "").strip()
    output_path = Path(configured_output).expanduser() if configured_output else Path.home() / "Documents" / "pingbacks.txt"
    api_base = f"{API_ROOT}/accounts/{account_id}/queues/{queue_id}"

    while True:
        try:
            appended, backlog = process_batch(api_base, token, output_path)
            if appended:
                print(f"Appended {appended} pingback(s) to {output_path}; queue backlog: {backlog}")
        except ConsumerError as error:
            print(str(error), file=sys.stderr)
            if args.once:
                return 1

        if args.once:
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ConsumerError, KeyboardInterrupt) as error:
        if isinstance(error, ConsumerError):
            print(str(error), file=sys.stderr)
            raise SystemExit(1) from error
        raise SystemExit(130) from error
