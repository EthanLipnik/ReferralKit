import importlib.util
import json
from pathlib import Path
import unittest


SCRIPT = Path(__file__).parents[1] / "Scripts" / "validate-worker-config.py"
SPEC = importlib.util.spec_from_file_location("validate_worker_config", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class WorkerConfigValidationTests(unittest.TestCase):
    def base_vars(self, environment: str) -> dict[str, str]:
        transaction_environment = "SANDBOX" if environment == "staging" else "PRODUCTION"
        values = {
            key: f"value-{key.lower()}"
            for key in MODULE.REQUIRED_VARIABLES
        }
        values.update({
            "ENVIRONMENT": environment,
            "PUBLIC_SITE_URL": "https://mirage.elipnik.com",
            "APP_STORE_URL": "https://apps.apple.com/app/id6757893115",
            "APP_STORE_ID": "6757893115",
            "ASSOCIATED_APP_IDS": "B6QG723P8Z.com.ethanlipnik.Mirage",
            "CODE_PREFIX": "MIRA",
            "AUTH_HEADER_PREFIX": "Mirage",
            "REVENUECAT_TRANSACTION_ENVIRONMENT": transaction_environment,
            "CONFIG_JSON": json.dumps({
                "schemaVersion": 1,
                "enabled": environment == "staging",
                "redemptionEnabled": True,
                "maxCreditsPerRedemption": 12,
                "extensionWindowDays": 7,
            }),
        })
        return values

    def config(self, environment: str) -> dict:
        vars = self.base_vars(environment)
        database = [{"database_name": "referrals", "database_id": "49cb74db-bc3f-4f91-b242-af84d7f07b24"}]
        routes = [{"pattern": "mirage.elipnik.com", "custom_domain": True}]
        if environment == "staging":
            return {"env": {"staging": {
                "vars": vars,
                "d1_databases": database,
                "routes": routes,
            }}}
        return {"vars": vars, "d1_databases": database, "routes": routes}

    def test_production_requires_disabled_enrollment(self):
        config = self.config("production")
        config["vars"]["CONFIG_JSON"] = json.dumps({
            "schemaVersion": 1,
            "enabled": True,
            "redemptionEnabled": True,
            "maxCreditsPerRedemption": 12,
            "extensionWindowDays": 7,
        })
        errors = MODULE.validate(config, "production")
        self.assertIn("production CONFIG_JSON.enabled must be false for disabled-first deployment", errors)

    def test_production_promotion_requires_explicit_validation_mode(self):
        config = self.config("production")
        config["vars"]["CONFIG_JSON"] = json.dumps({
            "schemaVersion": 1,
            "enabled": True,
            "redemptionEnabled": True,
            "maxCreditsPerRedemption": 12,
            "extensionWindowDays": 7,
        })
        self.assertEqual(
            MODULE.validate(config, "production", allow_production_enrollment=True),
            [],
        )

    def test_production_promotion_rejects_disabled_config(self):
        errors = MODULE.validate(
            self.config("production"),
            "production",
            allow_production_enrollment=True,
        )
        self.assertIn(
            "production CONFIG_JSON.enabled must be true for enrollment promotion",
            errors,
        )

    def test_missing_sender_reference_name_is_rejected(self):
        config = self.config("staging")
        del config["env"]["staging"]["vars"]["SENDER_NEW_YEARLY_OFFER_REFERENCE_NAME"]
        errors = MODULE.validate(config, "staging")
        self.assertIn("staging SENDER_NEW_YEARLY_OFFER_REFERENCE_NAME is missing or a placeholder", errors)

    def test_placeholder_binding_is_rejected(self):
        config = self.config("staging")
        config["env"]["staging"]["vars"]["RECIPIENT_MONTHLY_OFFER_REFERENCE_NAME"] = "REPLACE_WITH_APP_STORE_CONNECT_REFERENCE_NAME"
        errors = MODULE.validate(config, "staging")
        self.assertIn("staging RECIPIENT_MONTHLY_OFFER_REFERENCE_NAME is missing or a placeholder", errors)

    def test_missing_associated_app_ids_is_rejected(self):
        config = self.config("staging")
        del config["env"]["staging"]["vars"]["ASSOCIATED_APP_IDS"]
        errors = MODULE.validate(config, "staging")
        self.assertIn("staging ASSOCIATED_APP_IDS is missing or a placeholder", errors)

    def test_known_template_values_are_rejected(self):
        config = self.config("staging")
        vars = config["env"]["staging"]["vars"]
        vars["APP_STORE_ID"] = "1234567890"
        vars["APP_STORE_URL"] = "https://apps.apple.com/app/id1234567890"
        vars["ASSOCIATED_APP_IDS"] = "TEAM_ID.com.example.app"
        errors = MODULE.validate(config, "staging")
        self.assertIn("staging APP_STORE_ID is missing or a placeholder", errors)
        self.assertIn("staging ASSOCIATED_APP_IDS is missing or a placeholder", errors)

    def test_public_identifiers_and_urls_are_shape_checked(self):
        config = self.config("staging")
        vars = config["env"]["staging"]["vars"]
        vars["PUBLIC_SITE_URL"] = "http://mirage.elipnik.com/referrals"
        vars["APP_STORE_URL"] = "https://apps.apple.com/app/id9999999999"
        vars["ASSOCIATED_APP_IDS"] = "bad.bundle.id"
        errors = MODULE.validate(config, "staging")
        self.assertIn("staging PUBLIC_SITE_URL must be an HTTPS origin without a path", errors)
        self.assertIn("staging APP_STORE_URL must be an apps.apple.com URL for APP_STORE_ID", errors)
        self.assertIn("staging ASSOCIATED_APP_IDS must contain Team-ID-qualified bundle IDs", errors)

    def test_offer_resource_cannot_cross_products(self):
        config = self.config("staging")
        vars = config["env"]["staging"]["vars"]
        vars["RECIPIENT_MONTHLY_OFFER_ID"] = "shared-resource"
        vars["RECIPIENT_YEARLY_OFFER_ID"] = "shared-resource"
        errors = MODULE.validate(config, "staging")
        self.assertIn(
            "staging offer-code resource IDs cannot be shared across monthly and yearly products",
            errors,
        )

    def test_public_site_requires_a_matching_referral_route(self):
        config = self.config("production")
        config["routes"] = [{
            "pattern": "referrals.mirage.elipnik.com",
            "custom_domain": True,
        }]

        errors = MODULE.validate(config, "production")

        self.assertIn(
            "production routes must send PUBLIC_SITE_URL /r/* links to this Worker",
            errors,
        )

    def test_public_site_accepts_a_path_route_for_an_externally_hosted_aasa(self):
        config = self.config("production")
        config["routes"] = [{
            "pattern": "mirage.elipnik.com/r/*",
            "zone_name": "elipnik.com",
        }]

        self.assertEqual(MODULE.validate(config, "production"), [])

    def test_staging_custom_domain_covers_referral_links_and_worker_aasa(self):
        config = self.config("staging")
        config["env"]["staging"]["routes"] = [{
            "pattern": "mirage.elipnik.com",
            "custom_domain": True,
        }]

        self.assertEqual(MODULE.validate(config, "staging"), [])


if __name__ == "__main__":
    unittest.main()
