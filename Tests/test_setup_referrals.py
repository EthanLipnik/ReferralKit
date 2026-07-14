import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "Scripts" / "setup-referrals.py"
SPEC = importlib.util.spec_from_file_location("setup_referrals", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class SetupReferralsTests(unittest.TestCase):
    def test_example_configuration_validates(self):
        example = Path(__file__).parents[1] / "Examples" / "referral-program.example.json"
        configuration = MODULE.load_config(example)
        self.assertEqual(configuration["app_id"], "1234567890")

    def test_rejects_empty_subscriptions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps({"app_id": "123", "subscriptions": []}))
            with self.assertRaises(MODULE.SetupError):
                MODULE.load_config(path)


if __name__ == "__main__":
    unittest.main()
