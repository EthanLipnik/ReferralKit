#!/usr/bin/env python3
"""Create a temporary production Worker manifest with enrollment disabled."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
import tomllib


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--environment", choices=("production",), required=True)
    return parser.parse_args()


def disabled_manifest(source: str) -> str:
    """Replace only the root [vars] CONFIG_JSON TOML assignment.

    Concrete product manifests use a single-line JSON literal for CONFIG_JSON.
    Keeping that restriction here avoids reserializing a product manifest and
    accidentally changing bindings, routes, or other deployment settings.
    """
    root_vars = re.compile(
        r"(?ms)(^\[vars\]\s*$)(.*?)(?=^\[|\Z)",
    )
    match = root_vars.search(source)
    if not match:
        raise ValueError("missing root [vars] table")
    section = match.group(2)
    config_match = re.search(r"(?m)^CONFIG_JSON\s*=\s*([^\r\n]+)$", section)
    if not config_match:
        raise ValueError("root [vars] CONFIG_JSON must be a single-line TOML assignment")
    try:
        parsed = tomllib.loads("CONFIG_JSON = " + config_match.group(1))["CONFIG_JSON"]
        config = json.loads(parsed)
    except (tomllib.TOMLDecodeError, json.JSONDecodeError, TypeError) as error:
        raise ValueError(f"unable to parse root CONFIG_JSON: {error}") from error
    if not isinstance(config, dict) or config.get("enabled") is not True:
        raise ValueError("root CONFIG_JSON.enabled must be true for enrollment promotion")
    config["enabled"] = False
    replacement = "CONFIG_JSON = '" + json.dumps(config, separators=(",", ":"), ensure_ascii=False) + "'"
    rewritten_section = section[:config_match.start()] + replacement + section[config_match.end():]
    return source[:match.start(2)] + rewritten_section + source[match.end(2):]


def main() -> int:
    arguments = parse_args()
    try:
        source = arguments.config.read_text()
        arguments.output.write_text(disabled_manifest(source))
    except (OSError, ValueError) as error:
        print(f"unable to create disabled Worker manifest: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
