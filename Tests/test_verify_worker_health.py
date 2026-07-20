import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).parents[1] / "Scripts" / "verify-worker-health.py"
SPEC = importlib.util.spec_from_file_location("verify_worker_health", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class WorkerHealthVerificationTests(unittest.TestCase):
    def test_disabled_first_deployment_can_be_healthy_before_inventory(self):
        payload = {
            "ok": True,
            "readyForEnrollment": False,
            "environment": "production",
            "readinessIssues": ["offer_code_inventory"],
        }
        self.assertEqual(MODULE.validate(payload, "production", False), [])
        self.assertEqual(
            MODULE.validate(payload, "production", True),
            ["Worker is not ready for enrollment: offer_code_inventory"],
        )

    def test_environment_and_health_must_match(self):
        payload = {"ok": False, "readyForEnrollment": True, "environment": "staging"}
        self.assertEqual(
            MODULE.validate(payload, "production", True),
            ["Worker health is not ok", "Worker environment must equal 'production'"],
        )


if __name__ == "__main__":
    unittest.main()
