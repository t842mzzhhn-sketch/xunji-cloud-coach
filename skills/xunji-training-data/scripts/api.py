#!/usr/bin/env python3
"""Send allowlisted Xunji Open API requests without exposing credentials."""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

OPERATIONS = {
    "train-query": ("https://trains.xunjiapp.cn/api_trains_for_llm_v2", "training", False),
    "movement-catalog": ("https://trains.xunjiapp.cn/api_movement_catalog_for_llm_v2", "training", False),
    "train-upsert": ("https://trains.xunjiapp.cn/api_upsert_trains_for_llm_v2", "training", True),
    "plan-query": ("https://api.xunjiapp.cn/open/plan/query_gzip", "training", False),
}
ENV_NAMES = {"training": "XUNJI_TRAIN_API_KEY"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=sorted(OPERATIONS))
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--payload", type=Path, help="Path to a JSON request body")
    source.add_argument("--json", help="Inline JSON request body")
    parser.add_argument("--confirmed", action="store_true", help="Required for every upstream training mutation")
    parser.add_argument("--validate-only", action="store_true", help="Validate locally without sending a request")
    parser.add_argument("--timeout", type=float, default=30.0)
    return parser.parse_args()


def load_payload(args: argparse.Namespace) -> dict[str, Any]:
    raw = args.payload.read_text(encoding="utf-8") if args.payload else args.json
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("request payload must be a JSON object")
    return value


def load_token(kind: str) -> str:
    token = os.environ.get(ENV_NAMES[kind], "").strip()
    if token:
        return token
    path = Path(os.environ.get("XUNJI_CREDENTIALS_FILE", Path.home() / ".codex/secrets/xunji-open-api.json"))
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        token = str(data.get(kind, "")).strip()
    except (OSError, json.JSONDecodeError):
        token = ""
    if not token:
        raise RuntimeError(f"missing credential: set {ENV_NAMES[kind]} or configure {path}")
    return token


def main() -> int:
    args = parse_args()
    try:
        payload = load_payload(args)
        url, credential_kind, mutating = OPERATIONS[args.operation]
        if args.validate_only:
            print(json.dumps({"valid": True, "operation": args.operation}, ensure_ascii=False))
            return 0
        if mutating and payload.get("dry_run") is True:
            raise ValueError(
                "upstream training dry_run is not guaranteed side-effect free; "
                "use --validate-only before confirmation, then dry_run:false with --confirmed"
            )
        if mutating and not args.confirmed:
            raise ValueError("upstream training mutation requires explicit --confirmed")
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        request = urllib.request.Request(
            url,
            data=body,
            headers={
                "Authorization": f"Bearer {load_token(credential_kind)}",
                "Content-Type": "application/json",
                "Accept-Encoding": "gzip",
                "User-Agent": "codex-xunji-skill/1",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            raw = response.read()
            if response.headers.get("Content-Encoding", "").lower() == "gzip" or raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
        print(json.dumps(json.loads(raw), ensure_ascii=False, indent=2))
        return 0
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        if exc.headers.get("Content-Encoding", "").lower() == "gzip" or raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        print(f"HTTP {exc.code}: {raw.decode('utf-8', 'replace')}", file=sys.stderr)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
