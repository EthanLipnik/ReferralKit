#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: Scripts/deploy-worker.sh <staging|production> --config <wrangler.toml> --base-url <https://worker.example> [--require-enrollment-ready]

Validates the concrete Worker configuration, runs the Worker test suite, applies
migrations, deploys the selected environment, and verifies /health. Production
deployment is rejected unless CONFIG_JSON.enabled is false.
Use --require-enrollment-ready for the final inventory-backed canary check.
EOF
}

environment="${1:-}"
if [[ "$environment" != "staging" && "$environment" != "production" ]]; then
    usage >&2
    exit 64
fi
shift

config_path=""
base_url=""
require_enrollment_ready=false
while (($#)); do
    case "$1" in
        --config)
            config_path="${2:-}"
            shift 2
            ;;
        --require-enrollment-ready)
            require_enrollment_ready=true
            shift
            ;;
        --base-url)
            base_url="${2:-}"
            shift 2
            ;;
        *)
            usage >&2
            exit 64
            ;;
    esac
done

if [[ -z "$config_path" || -z "$base_url" ]]; then
    usage >&2
    exit 64
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_path="$(cd "$(dirname "$config_path")" && pwd)/$(basename "$config_path")"
worker_dir="$repository_root/Worker"

if [[ ! -f "$config_path" ]]; then
    echo "Worker configuration does not exist: $config_path" >&2
    exit 66
fi
if [[ ! "$base_url" =~ ^https://[^/]+$ ]]; then
    echo "--base-url must be an HTTPS origin without a path." >&2
    exit 64
fi

python3 "$repository_root/Scripts/validate-worker-config.py" \
    --config "$config_path" \
    --environment "$environment"

# Wrangler resolves the Worker entrypoint relative to the manifest. Keep the
# concrete product manifest outside source control, but use a temporary copy in
# Worker so generic manifests can retain `main = "src/index.ts"`.
deployment_config="$(mktemp "$worker_dir/.wrangler.deploy.XXXXXX.toml")"
cp "$config_path" "$deployment_config"
trap 'rm -f "$deployment_config"' EXIT

database_name="$({
    CONFIG_PATH="$config_path" DEPLOY_ENVIRONMENT="$environment" python3 - <<'PY'
import os
from pathlib import Path
import tomllib

config = tomllib.loads(Path(os.environ["CONFIG_PATH"]).read_text())
if os.environ["DEPLOY_ENVIRONMENT"] == "staging":
    database = config["env"]["staging"]["d1_databases"][0]
else:
    database = config["d1_databases"][0]
print(database["database_name"])
PY
} )"

pushd "$worker_dir" >/dev/null
npm ci
npm test
npm run build

if [[ "$environment" == "staging" ]]; then
    worker_secrets="$(npx wrangler secret list --config "$deployment_config" --env staging --format json)"
else
    worker_secrets="$(npx wrangler secret list --config "$deployment_config" --format json)"
fi
WORKER_SECRETS="$worker_secrets" python3 - <<'PY'
import json
import os

required = {
    "REVENUECAT_SECRET_KEY",
    "REVENUECAT_WEBHOOK_SECRET",
    "REVENUECAT_WEBHOOK_SIGNING_SECRET",
    "CODE_HASH_SECRET",
    "IDENTITY_HASH_SECRET",
    "OFFER_CODE_ENCRYPTION_KEY",
    "OFFER_CODE_IMPORT_SECRET",
}
try:
    payload = json.loads(os.environ["WORKER_SECRETS"])
except json.JSONDecodeError as error:
    raise SystemExit(f"Wrangler did not return a secret list: {error}")
names = {
    item.get("name")
    for item in payload
    if isinstance(item, dict) and isinstance(item.get("name"), str)
}
missing = sorted(required - names)
if missing:
    raise SystemExit("Worker is missing required secrets: " + ", ".join(missing))
PY

if [[ "$environment" == "staging" ]]; then
    npx wrangler d1 migrations apply "$database_name" --config "$deployment_config" --env staging --remote
    npx wrangler deploy --config "$deployment_config" --env staging
else
    npx wrangler d1 migrations apply "$database_name" --config "$deployment_config" --remote
    npx wrangler deploy --config "$deployment_config"
fi
popd >/dev/null

response="$(curl --fail --silent --show-error "$base_url/health")"
health_arguments=(--environment "$environment")
if [[ "$require_enrollment_ready" == true ]]; then
    health_arguments+=(--require-enrollment-ready)
fi
if ! printf '%s' "$response" | python3 "$repository_root/Scripts/verify-worker-health.py" "${health_arguments[@]}"; then
    echo "Unexpected health response from $base_url/health: $response" >&2
    exit 1
fi
echo "ReferralKit Worker $environment deployment verified at $base_url/health."
