import importlib.util
import json
from pathlib import Path
import unittest


SCRIPT = Path(__file__).parents[1] / "Scripts" / "create-disabled-worker-config.py"
SPEC = importlib.util.spec_from_file_location("create_disabled_worker_config", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DisabledWorkerConfigTests(unittest.TestCase):
    def test_changes_only_root_production_enrollment(self):
        production = json.dumps({"schemaVersion": 1, "enabled": True})
        staging = json.dumps({"schemaVersion": 1, "enabled": True})
        source = (
            'name = "referrals"\n\n[vars]\n'
            f"CONFIG_JSON = '{production}'\n"
            'OTHER = "unchanged"\n\n[env.staging.vars]\n'
            f"CONFIG_JSON = '{staging}'\n"
        )
        result = MODULE.disabled_manifest(source)
        root = result.split("[env.staging.vars]", 1)[0]
        self.assertIn('"enabled":false', root)
        self.assertIn(f"CONFIG_JSON = '{staging}'", result)
        self.assertIn('OTHER = "unchanged"', result)

    def test_rejects_a_config_that_is_not_an_intentional_promotion(self):
        source = "[vars]\nCONFIG_JSON = '{\"schemaVersion\":1,\"enabled\":false}'\n"
        with self.assertRaisesRegex(ValueError, "must be true"):
            MODULE.disabled_manifest(source)


if __name__ == "__main__":
    unittest.main()
