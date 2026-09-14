#!/usr/bin/env bash
# Bash/zsh mirror of terraform-with-secrets.ps1, for Mac and Linux. Loads the
# social sign-in credentials out of Secrets Manager into TF_VAR_* env vars
# (via social-signin-env.sh) for the lifetime of this one terraform command,
# so the values never sit on disk in a .tfvars file.
#
# Usage:
#   ./terraform-with-secrets.sh plan
#   ./terraform-with-secrets.sh apply
#   ./terraform-with-secrets.sh apply --auto-approve
#
# Pass a different secret with BMS_SOCIAL_SECRET_ARN, and a different var
# file with VAR_FILE (default: serverless.tfvars). Run it, don't source it -
# unlike social-signin-env.sh, this is a self-contained command that starts
# and ends its own terraform run.

set -euo pipefail

COMMAND="${1:-plan}"
if [[ "$COMMAND" != "plan" && "$COMMAND" != "apply" ]]; then
    echo "Usage: $0 <plan|apply> [--auto-approve]" >&2
    exit 1
fi
shift || true

VAR_FILE="${VAR_FILE:-serverless.tfvars}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v terraform >/dev/null 2>&1; then
    echo "Terraform was not found on PATH." >&2
    exit 1
fi
if [[ ! -f "$VAR_FILE" ]]; then
    echo "Terraform variable file was not found: $VAR_FILE" >&2
    exit 1
fi

REQUIRED_VARS=(google_client_id google_client_secret apple_services_id apple_team_id apple_key_id apple_private_key)

# `source file` with no explicit arguments inherits *this* script's current
# positional parameters (e.g. --auto-approve) as the sourced script's "$@" -
# social-signin-env.sh takes an optional secret ARN override there, so
# without clearing them first, --auto-approve gets passed as that override.
EXTRA_ARGS=("$@")
set --
# shellcheck source=./social-signin-env.sh
source "$SCRIPT_DIR/social-signin-env.sh"
set -- "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"

for name in "${REQUIRED_VARS[@]}"; do
    var="TF_VAR_$name"
    if [[ -z "${!var:-}" ]]; then
        echo "The social sign-in secret did not provide a non-empty '$name' value." >&2
        exit 1
    fi
done

terraform "$COMMAND" -var-file="$VAR_FILE" "$@"
