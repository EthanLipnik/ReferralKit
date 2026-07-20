#!/usr/bin/env python3
"""Verify a deployed ReferralKit Worker's health response."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any


def validate(payload: Any, environment: str, require_enrollment_ready: bool) -> list[str]:
    if not isinstance(payload, dict):
        return ["health response must be a JSON object"]
    errors: list[str] = []
    if payload.get("ok") is not True:
        errors.append("Worker health is not ok")
    if payload.get("environment") != environment:
        errors.append(f"Worker environment must equal {environment!r}")
    if require_enrollment_ready and payload.get("readyForEnrollment") is not True:
        issues = payload.get("readinessIssues")
        detail = ", ".join(str(issue) for issue in issues) if isinstance(issues, list) else "unknown"
        errors.append(f"Worker is not ready for enrollment: {detail}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", choices=("staging", "production"), required=True)
    parser.add_argument("--require-enrollment-ready", action="store_true")
    arguments = parser.parse_args()
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        print(f"Worker health response is not valid JSON: {error}", file=sys.stderr)
        return 2
    errors = validate(payload, arguments.environment, arguments.require_enrollment_ready)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
