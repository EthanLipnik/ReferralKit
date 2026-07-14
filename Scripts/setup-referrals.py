#!/usr/bin/env python3
"""Plan or apply App Store Connect subscription offers for ReferralKit."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any


EXIT_VALIDATION = 2
EXIT_ASC = 3
EXIT_DRIFT = 4
EXIT_PARTIAL_APPLY = 5


class SetupError(Exception):
    def __init__(self, message: str, exit_code: int = EXIT_VALIDATION) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Plan or create App Store subscription offers used by a referral program."
    )
    parser.add_argument("--config", type=Path, required=True, help="JSON program configuration.")
    parser.add_argument("--apply", action="store_true", help="Create missing resources. Default is read-only plan mode.")
    parser.add_argument(
        "--offline-plan",
        action="store_true",
        help="Validate and print commands without authenticating or reading App Store Connect.",
    )
    parser.add_argument("--profile", help="Named asc authentication profile.")
    parser.add_argument("--state", type=Path, help="Receipt file used to prevent duplicate one-time code batches.")
    parser.add_argument("--summary", type=Path, help="Write the machine-readable result to this path.")
    args = parser.parse_args()
    if args.apply and args.offline_plan:
        parser.error("--apply and --offline-plan cannot be used together")
    return args


def load_config(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise SetupError(f"cannot read configuration: {error}") from error
    if not isinstance(value, dict):
        raise SetupError("configuration root must be an object")
    required_string(value, "app_id", "configuration")
    subscriptions = value.get("subscriptions")
    if not isinstance(subscriptions, list) or not subscriptions:
        raise SetupError("configuration.subscriptions must be a non-empty array")
    for index, subscription in enumerate(subscriptions):
        label = f"subscriptions[{index}]"
        if not isinstance(subscription, dict):
            raise SetupError(f"{label} must be an object")
        required_string(subscription, "product", label)
        validate_offer_codes(subscription.get("offer_codes", []), label)
        validate_promotional_offers(subscription.get("promotional_offers", []), label)
    return value


def required_string(value: dict[str, Any], key: str, label: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result.strip():
        raise SetupError(f"{label}.{key} must be a non-empty string")
    return result


def validate_offer_codes(value: Any, label: str) -> None:
    if not isinstance(value, list):
        raise SetupError(f"{label}.offer_codes must be an array")
    for index, offer in enumerate(value):
        item = f"{label}.offer_codes[{index}]"
        if not isinstance(offer, dict):
            raise SetupError(f"{item} must be an object")
        for key in ("name", "offer_eligibility", "offer_duration", "offer_mode"):
            required_string(offer, key, item)
        require_string_list(offer, "customer_eligibilities", item)
        require_string_list(offer, "prices", item)
        require_positive_int(offer, "number_of_periods", item)
        batch = offer.get("one_time_codes")
        if batch is not None:
            if not isinstance(batch, dict):
                raise SetupError(f"{item}.one_time_codes must be an object")
            require_positive_int(batch, "quantity", f"{item}.one_time_codes")
            required_string(batch, "expiration_date", f"{item}.one_time_codes")
            required_string(batch, "output", f"{item}.one_time_codes")


def validate_promotional_offers(value: Any, label: str) -> None:
    if not isinstance(value, list):
        raise SetupError(f"{label}.promotional_offers must be an array")
    for index, offer in enumerate(value):
        item = f"{label}.promotional_offers[{index}]"
        if not isinstance(offer, dict):
            raise SetupError(f"{item} must be an object")
        for key in ("offer_code", "name", "offer_duration", "offer_mode"):
            required_string(offer, key, item)
        require_string_list(offer, "prices", item)
        require_positive_int(offer, "number_of_periods", item)


def require_string_list(value: dict[str, Any], key: str, label: str) -> list[str]:
    result = value.get(key)
    if not isinstance(result, list) or not result or not all(isinstance(item, str) and item for item in result):
        raise SetupError(f"{label}.{key} must be a non-empty string array")
    return result


def require_positive_int(value: dict[str, Any], key: str, label: str) -> int:
    result = value.get(key)
    if not isinstance(result, int) or isinstance(result, bool) or result < 1:
        raise SetupError(f"{label}.{key} must be a positive integer")
    return result


class ASC:
    def __init__(self, profile: str | None, apply: bool, offline: bool) -> None:
        self.profile = profile
        self.apply = apply
        self.offline = offline
        self.actions: list[dict[str, Any]] = []

    def argv(self, *arguments: str) -> list[str]:
        command = ["asc"]
        if self.profile:
            command.extend(["--profile", self.profile])
        command.extend(arguments)
        return command

    def read_json(self, *arguments: str) -> Any:
        command = self.argv(*arguments)
        if self.offline:
            return {"data": []}
        return run_json(command)

    def mutation(self, description: str, arguments: list[str]) -> Any | None:
        command = self.argv(*arguments)
        self.actions.append({"description": description, "command": command, "applied": self.apply})
        print(f"{'APPLY' if self.apply else 'PLAN '} {description}", file=sys.stderr)
        print("       " + subprocess.list2cmdline(command), file=sys.stderr)
        if not self.apply:
            return None
        return run_json(command)


def run_json(command: list[str]) -> Any:
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or "unknown asc error"
        raise SetupError(f"asc failed ({completed.returncode}): {detail}", EXIT_ASC)
    try:
        return json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as error:
        raise SetupError(f"asc returned invalid JSON: {error}", EXIT_ASC) from error


def resources(payload: Any) -> list[dict[str, Any]]:
    data = payload.get("data", []) if isinstance(payload, dict) else payload
    if isinstance(data, dict):
        return [data]
    return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []


def attributes(resource: dict[str, Any]) -> dict[str, Any]:
    value = resource.get("attributes", {})
    return value if isinstance(value, dict) else {}


def resource_id(payload: Any) -> str:
    items = resources(payload)
    if len(items) != 1 or not isinstance(items[0].get("id"), str):
        raise SetupError("asc response did not contain exactly one resource ID", EXIT_ASC)
    return items[0]["id"]


def one_match(items: list[dict[str, Any]], keys: tuple[str, ...], expected: str, label: str) -> dict[str, Any] | None:
    matches = []
    for item in items:
        candidate = attributes(item)
        values = [candidate.get(key) for key in keys]
        if expected in values:
            matches.append(item)
    if len(matches) > 1:
        raise SetupError(f"multiple existing {label} resources match {expected!r}", EXIT_DRIFT)
    return matches[0] if matches else None


def verify_fields(resource: dict[str, Any], requested: dict[str, Any], mapping: dict[str, tuple[str, ...]], label: str) -> None:
    current = attributes(resource)
    drift: list[str] = []
    for request_key, possible_keys in mapping.items():
        expected = requested[request_key]
        observed = next((current[key] for key in possible_keys if key in current), None)
        if observed is not None and normalize(observed) != normalize(expected):
            drift.append(f"{request_key}: existing={observed!r}, requested={expected!r}")
    if drift:
        raise SetupError(f"existing {label} cannot be safely reconciled:\n  " + "\n  ".join(drift), EXIT_DRIFT)


def normalize(value: Any) -> Any:
    if isinstance(value, list):
        return sorted(str(item) for item in value)
    return str(value)


def offer_code_arguments(app_id: str, product: str, offer: dict[str, Any]) -> list[str]:
    return [
        "subscriptions", "offers", "offer-codes", "create",
        "--app", app_id,
        "--subscription-id", product,
        "--name", offer["name"],
        "--offer-eligibility", offer["offer_eligibility"],
        "--customer-eligibilities", ",".join(offer["customer_eligibilities"]),
        "--offer-duration", offer["offer_duration"],
        "--offer-mode", offer["offer_mode"],
        "--number-of-periods", str(offer["number_of_periods"]),
        "--prices", ",".join(offer["prices"]),
        "--output", "json",
    ]


def promotional_arguments(app_id: str, product: str, offer: dict[str, Any]) -> list[str]:
    return [
        "subscriptions", "offers", "promotional", "create",
        "--app", app_id,
        "--subscription-id", product,
        "--offer-code", offer["offer_code"],
        "--name", offer["name"],
        "--offer-duration", offer["offer_duration"],
        "--offer-mode", offer["offer_mode"],
        "--number-of-periods", str(offer["number_of_periods"]),
        "--prices", ",".join(offer["prices"]),
        "--output", "json",
    ]


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"generated_batches": {}}
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise SetupError(f"cannot read state file: {error}") from error
    if not isinstance(value, dict):
        raise SetupError("state file must contain an object")
    value.setdefault("generated_batches", {})
    return value


def write_private_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def generate_batch(
    asc: ASC,
    app_id: str,
    product: str,
    offer_name: str,
    offer_id: str | None,
    batch: dict[str, Any],
    state_path: Path,
    state: dict[str, Any],
) -> None:
    key = "|".join([app_id, product, offer_name, batch["expiration_date"], str(batch["quantity"])])
    if key in state["generated_batches"]:
        print(f"NOOP  one-time code batch already recorded for {offer_name}", file=sys.stderr)
        return
    output = Path(batch["output"]).expanduser().resolve()
    if output.exists():
        raise SetupError(f"refusing to overwrite one-time code output: {output}", EXIT_DRIFT)
    if offer_id is None:
        print(f"PLAN  generate {batch['quantity']} one-time codes for {offer_name} after offer creation", file=sys.stderr)
        return
    command = asc.argv(
        "subscriptions", "offers", "offer-codes", "generate",
        "--offer-code-id", offer_id,
        "--quantity", str(batch["quantity"]),
        "--expiration-date", batch["expiration_date"],
        "--output", str(output),
        "--output-format", "json",
    )
    asc.actions.append({"description": f"generate one-time code batch for {offer_name}", "command": command, "applied": asc.apply})
    print(f"{'APPLY' if asc.apply else 'PLAN '} generate {batch['quantity']} one-time codes for {offer_name}", file=sys.stderr)
    if not asc.apply:
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    old_umask = os.umask(0o077)
    try:
        run_json(command)
    except SetupError as error:
        raise SetupError(str(error), EXIT_PARTIAL_APPLY) from error
    finally:
        os.umask(old_umask)
    os.chmod(output, 0o600)
    state["generated_batches"][key] = {
        "offer_id": offer_id,
        "output": str(output),
        "quantity": batch["quantity"],
        "expiration_date": batch["expiration_date"],
    }
    write_private_json(state_path, state)


def configure(config: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    app_id = config["app_id"]
    state_path = args.state or args.config.with_suffix(".state.json")
    state = load_state(state_path)
    asc = ASC(args.profile, args.apply, args.offline_plan)

    if not args.offline_plan:
        asc.read_json("auth", "status", "--output", "json")
        asc.read_json("subscriptions", "list", "--app", app_id, "--paginate", "--output", "json")

    for subscription in config["subscriptions"]:
        product = subscription["product"]
        existing_codes = resources(asc.read_json(
            "subscriptions", "offers", "offer-codes", "list",
            "--app", app_id,
            "--subscription-id", product,
            "--paginate",
            "--output", "json",
        ))
        existing_promotional = resources(asc.read_json(
            "subscriptions", "offers", "promotional", "list",
            "--app", app_id,
            "--subscription-id", product,
            "--paginate",
            "--output", "json",
        ))

        for offer in subscription.get("offer_codes", []):
            match = one_match(existing_codes, ("name", "offerCodeName"), offer["name"], "offer code")
            offer_id: str | None = None
            if match:
                verify_fields(
                    match,
                    offer,
                    {
                        "offer_eligibility": ("offerEligibility", "offer_eligibility"),
                        "customer_eligibilities": ("customerEligibilities", "customer_eligibilities"),
                        "offer_duration": ("duration", "offerDuration", "offer_duration"),
                        "offer_mode": ("mode", "offerMode", "offer_mode"),
                        "number_of_periods": ("numberOfPeriods", "number_of_periods"),
                    },
                    offer["name"],
                )
                offer_id = match.get("id")
                print(f"NOOP  offer code {offer['name']} already exists", file=sys.stderr)
            else:
                result = asc.mutation(f"create offer code {offer['name']} for {product}", offer_code_arguments(app_id, product, offer))
                if result is not None:
                    offer_id = resource_id(result)
            if offer.get("one_time_codes"):
                generate_batch(asc, app_id, product, offer["name"], offer_id, offer["one_time_codes"], state_path, state)

        for offer in subscription.get("promotional_offers", []):
            match = one_match(existing_promotional, ("offerCode", "offer_code"), offer["offer_code"], "promotional offer")
            if match:
                verify_fields(
                    match,
                    offer,
                    {
                        "name": ("name",),
                        "offer_duration": ("duration", "offerDuration", "offer_duration"),
                        "offer_mode": ("mode", "offerMode", "offer_mode"),
                        "number_of_periods": ("numberOfPeriods", "number_of_periods"),
                    },
                    offer["offer_code"],
                )
                print(f"NOOP  promotional offer {offer['offer_code']} already exists", file=sys.stderr)
            else:
                asc.mutation(
                    f"create promotional offer {offer['offer_code']} for {product}",
                    promotional_arguments(app_id, product, offer),
                )

    return {
        "mode": "offline-plan" if args.offline_plan else "apply" if args.apply else "plan",
        "app_id": app_id,
        "actions": asc.actions,
        "state_file": str(state_path),
    }


def main() -> int:
    args = parse_args()
    try:
        result = configure(load_config(args.config), args)
        rendered = json.dumps(result, indent=2)
        if args.summary:
            write_private_json(args.summary, result)
        print(rendered)
        return 0
    except SetupError as error:
        print(f"error: {error}", file=sys.stderr)
        return error.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
