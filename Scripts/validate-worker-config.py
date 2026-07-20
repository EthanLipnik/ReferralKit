#!/usr/bin/env python3
"""Validate a concrete ReferralKit Worker deployment configuration."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
import tomllib
from typing import Any
from urllib.parse import urlparse


REQUIRED_VARIABLES = (
    "ENVIRONMENT",
    "PUBLIC_SITE_URL",
    "APP_STORE_URL",
    "APP_STORE_ID",
    "ASSOCIATED_APP_IDS",
    "APP_NAME",
    "PRO_NAME",
    "CODE_PREFIX",
    "AUTH_HEADER_PREFIX",
    "REGISTRATION_ATTRIBUTE_KEY",
    "REVENUECAT_API_BASE",
    "REVENUECAT_TRANSACTION_ENVIRONMENT",
    "REVENUECAT_ENTITLEMENT",
    "MONTHLY_PRODUCT_ID",
    "YEARLY_PRODUCT_ID",
    "LIFETIME_PRODUCT_IDS",
    "RECIPIENT_MONTHLY_OFFER_ID",
    "RECIPIENT_YEARLY_OFFER_ID",
    "RECIPIENT_MONTHLY_OFFER_REFERENCE_NAME",
    "RECIPIENT_YEARLY_OFFER_REFERENCE_NAME",
    "SENDER_MONTHLY_PROMOTIONAL_OFFER_ID",
    "SENDER_YEARLY_PROMOTIONAL_OFFER_ID",
    "SENDER_MONTHLY_PROMOTIONAL_OFFER_2_MONTHS_ID",
    "SENDER_YEARLY_PROMOTIONAL_OFFER_2_MONTHS_ID",
    "SENDER_MONTHLY_PROMOTIONAL_OFFER_3_MONTHS_ID",
    "SENDER_YEARLY_PROMOTIONAL_OFFER_3_MONTHS_ID",
    "SENDER_MONTHLY_PROMOTIONAL_OFFER_6_MONTHS_ID",
    "SENDER_YEARLY_PROMOTIONAL_OFFER_6_MONTHS_ID",
    "SENDER_MONTHLY_PROMOTIONAL_OFFER_12_MONTHS_ID",
    "SENDER_YEARLY_PROMOTIONAL_OFFER_12_MONTHS_ID",
    "SENDER_NEW_MONTHLY_OFFER_ID",
    "SENDER_NEW_YEARLY_OFFER_ID",
    "SENDER_NEW_MONTHLY_OFFER_REFERENCE_NAME",
    "SENDER_NEW_YEARLY_OFFER_REFERENCE_NAME",
    "CONFIG_JSON",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Reject incomplete or unsafe ReferralKit Worker deployment configuration."
    )
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--environment", choices=("staging", "production"), required=True)
    return parser.parse_args()


def environment_values(configuration: dict[str, Any], environment: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if environment == "production":
        variables = configuration.get("vars")
        databases = configuration.get("d1_databases")
    else:
        staging = configuration.get("env", {}).get("staging", {})
        variables = staging.get("vars")
        databases = staging.get("d1_databases")
    if not isinstance(variables, dict):
        raise ValueError(f"missing {environment} vars table")
    if not isinstance(databases, list):
        raise ValueError(f"missing {environment} d1_databases table")
    return variables, databases


KNOWN_TEMPLATE_VALUES = {
    "1234567890",
    "team_id.com.example.app",
    "example app",
    "example pro",
    "exmp",
    "example",
    "example_referral_registration_challenge",
}


def placeholder(value: Any) -> bool:
    if not isinstance(value, str):
        return True
    normalized = value.strip()
    lowered = normalized.lower()
    return (
        not normalized
        or "REPLACE_WITH" in normalized
        or "example.com" in lowered
        or ".example." in lowered
        or lowered.startswith("example_")
        or lowered in KNOWN_TEMPLATE_VALUES
    )


def https_url(value: Any, *, origin_only: bool) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return False
    if parsed.query or parsed.fragment:
        return False
    return not origin_only or parsed.path in ("", "/")


def validate(configuration: dict[str, Any], environment: str) -> list[str]:
    errors: list[str] = []
    try:
        variables, databases = environment_values(configuration, environment)
    except ValueError as error:
        return [str(error)]

    for key in REQUIRED_VARIABLES:
        if placeholder(variables.get(key)):
            errors.append(f"{environment} {key} is missing or a placeholder")

    if variables.get("ENVIRONMENT") != environment:
        errors.append(f"{environment} ENVIRONMENT must equal {environment!r}")
    expected_transaction_environment = "SANDBOX" if environment == "staging" else "PRODUCTION"
    if variables.get("REVENUECAT_TRANSACTION_ENVIRONMENT") != expected_transaction_environment:
        errors.append(
            f"{environment} REVENUECAT_TRANSACTION_ENVIRONMENT must equal {expected_transaction_environment!r}"
        )

    app_store_id = variables.get("APP_STORE_ID")
    if not isinstance(app_store_id, str) or not re.fullmatch(r"\d{9,12}", app_store_id):
        errors.append(f"{environment} APP_STORE_ID must be a 9-12 digit Apple app ID")
    public_site_url = variables.get("PUBLIC_SITE_URL")
    if not https_url(public_site_url, origin_only=True):
        errors.append(f"{environment} PUBLIC_SITE_URL must be an HTTPS origin without a path")
    app_store_url = variables.get("APP_STORE_URL")
    if (not https_url(app_store_url, origin_only=False) or
            urlparse(str(app_store_url)).hostname != "apps.apple.com" or
            not isinstance(app_store_id, str) or f"id{app_store_id}" not in urlparse(str(app_store_url)).path):
        errors.append(f"{environment} APP_STORE_URL must be an apps.apple.com URL for APP_STORE_ID")
    associated_app_ids = variables.get("ASSOCIATED_APP_IDS")
    associated_values = associated_app_ids.split(",") if isinstance(associated_app_ids, str) else []
    if (not associated_values or any(
        not re.fullmatch(r"[A-Z0-9]{10}\.[A-Za-z0-9.-]+", value.strip())
        for value in associated_values
    )):
        errors.append(f"{environment} ASSOCIATED_APP_IDS must contain Team-ID-qualified bundle IDs")
    if not re.fullmatch(r"[A-Za-z0-9]{2,12}", str(variables.get("CODE_PREFIX", ""))):
        errors.append(f"{environment} CODE_PREFIX must contain 2-12 letters or digits")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", str(variables.get("AUTH_HEADER_PREFIX", ""))):
        errors.append(f"{environment} AUTH_HEADER_PREFIX is not a valid HTTP header prefix")
    for key in ("MONTHLY_PRODUCT_ID", "YEARLY_PRODUCT_ID", "LIFETIME_PRODUCT_IDS"):
        values = str(variables.get(key, "")).split(",")
        if any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,}", value.strip()) for value in values):
            errors.append(f"{environment} {key} contains an invalid product identifier")

    monthly_offer_references = {
        variables.get("RECIPIENT_MONTHLY_OFFER_ID"),
        variables.get("SENDER_NEW_MONTHLY_OFFER_ID"),
    }
    yearly_offer_references = {
        variables.get("RECIPIENT_YEARLY_OFFER_ID"),
        variables.get("SENDER_NEW_YEARLY_OFFER_ID"),
    }
    conflicts = {value for value in monthly_offer_references & yearly_offer_references if isinstance(value, str)}
    if conflicts:
        errors.append(f"{environment} offer-code resource IDs cannot be shared across monthly and yearly products")

    database_id = databases[0].get("database_id") if len(databases) == 1 else None
    if (len(databases) != 1 or placeholder(database_id) or
            not isinstance(database_id, str) or
            not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", database_id)):
        errors.append(f"{environment} needs exactly one non-placeholder D1 database binding")

    config_json = variables.get("CONFIG_JSON")
    try:
        referral_config = json.loads(config_json) if isinstance(config_json, str) else None
    except json.JSONDecodeError:
        referral_config = None
    if not isinstance(referral_config, dict):
        errors.append(f"{environment} CONFIG_JSON must be a JSON object")
    else:
        for key in (
            "schemaVersion",
            "enabled",
            "redemptionEnabled",
            "maxCreditsPerRedemption",
            "extensionWindowDays",
        ):
            if key not in referral_config:
                errors.append(f"{environment} CONFIG_JSON is missing {key}")
        if referral_config.get("schemaVersion") != 1:
            errors.append(f"{environment} CONFIG_JSON.schemaVersion must equal 1")
        if environment == "production" and referral_config.get("enabled") is not False:
            errors.append("production CONFIG_JSON.enabled must be false for disabled-first deployment")
        if referral_config.get("redemptionEnabled") is not True:
            errors.append(f"{environment} CONFIG_JSON.redemptionEnabled must be true")

    return errors


def main() -> int:
    arguments = parse_args()
    try:
        configuration = tomllib.loads(arguments.config.read_text())
    except (OSError, tomllib.TOMLDecodeError) as error:
        print(f"unable to read Worker configuration: {error}", file=sys.stderr)
        return 2
    errors = validate(configuration, arguments.environment)
    if errors:
        print("ReferralKit Worker deployment configuration is not valid:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"ReferralKit Worker {arguments.environment} configuration is valid.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
