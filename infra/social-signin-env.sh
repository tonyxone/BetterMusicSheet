# Load the social sign-in AND Stripe billing credentials out of AWS Secrets
# Manager and into the TF_VAR_* environment variables Terraform reads, so the
# values never sit on disk in a .tfvars file. Despite the filename, this
# secret now holds both - they're loaded together because they already live
# in the one secret; nothing here treats them differently.
#
# SOURCE it, do not run it - exports have to land in your own shell:
#
#   source infra/social-signin-env.sh
#   terraform -chdir=infra apply -var-file=serverless.tfvars
#
# The secret must be a JSON object whose keys are the Terraform variable names
# from cognito-idp.tf and stripe.tf, e.g.
#
#   {
#     "google_client_id": "...",
#     "google_client_secret": "...",
#     "apple_cognito_services_id": "com.bettermusicsheet.signin",
#     "apple_cognito_team_id": "ABCDE12345",
#     "apple_cognito_key_id": "KEY1234567",
#     "apple_cognito_private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
#     "STRIPE_SECRET_KEY": "sk_...",
#     "STRIPE_WEBHOOK_SECRET": "whsec_...",
#     "STRIPE_PRICE_MONTHLY": "price_...",
#     "STRIPE_PRICE_YEARLY": "price_..."
#   }
#
# Only keys naming a real variable are exported; anything else is reported by
# NAME so a typo is obvious without the value ever being printed.
#
# Pass a different secret as the first argument, or set BMS_SOCIAL_SECRET_ARN.

_bms_load_social_secret() {
    # Deliberately no `set -e`/`set -u` anywhere in this file: it is sourced,
    # so those would apply to the caller's interactive shell and a later typo
    # would close their terminal.
    local default_arn="arn:aws:secretsmanager:us-west-1:324752064997:secret:better_music_sheet_singin_provider-eKRi1G"
    local arn="${1:-${BMS_SOCIAL_SECRET_ARN:-$default_arn}}"

    local tool
    for tool in aws jq; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            echo "social-signin-env: $tool is not installed." >&2
            return 1
        fi
    done

    local json
    if ! json=$(aws secretsmanager get-secret-value \
        --secret-id "$arn" --query SecretString --output text 2>&1); then
        echo "social-signin-env: couldn't read $arn" >&2
        echo "$json" >&2
        return 1
    fi

    if ! printf '%s' "$json" | jq -e 'type == "object"' >/dev/null 2>&1; then
        echo "social-signin-env: that secret isn't a JSON object of variable" >&2
        echo "  name -> value (see the comment at the top of this file)." >&2
        return 1
    fi

    # The Sign in with Apple keys were once named apple_* without "cognito".
    # A secret still using those names would load no Apple sign-in at all, and
    # Terraform would then delete the live Apple provider - so refuse instead.
    if printf '%s' "$json" | jq -e '(.apple_cognito_services_id // "") == "" and
            ([.apple_services_id, .apple_team_id, .apple_key_id, .apple_private_key] | any(. != null))' >/dev/null; then
        echo "social-signin-env: the secret uses the old apple_* Sign in with Apple names." >&2
        echo "  Rename them to apple_cognito_services_id, apple_cognito_team_id," >&2
        echo "  apple_cognito_key_id and apple_cognito_private_key." >&2
        return 1
    fi

    # Billing and Sign in with Apple use separate keys. An incomplete sign-in
    # key can otherwise fail halfway through apply after other resources change.
    local required=() missing=() required_key
    if printf '%s' "$json" | jq -e '(.apple_cognito_services_id // "") != ""' >/dev/null; then
        required+=(apple_cognito_services_id apple_cognito_team_id apple_cognito_key_id apple_cognito_private_key)
    fi
    if printf '%s' "$json" | jq -e '[.APPLE_KEY_ID // "", .APPLE_ISSUER_ID // "", .APPLE_PRIVATE_KEY // ""] | any(. != "")' >/dev/null; then
        required+=(APPLE_KEY_ID APPLE_ISSUER_ID APPLE_PRIVATE_KEY)
    fi
    for required_key in "${required[@]}"; do
        if ! printf '%s' "$json" | jq -e --arg key "$required_key" '.[$key] | type == "string" and length > 0' >/dev/null; then
            missing+=("$required_key")
        fi
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        echo "social-signin-env: incomplete Apple credentials; missing or empty: ${missing[*]}" >&2
        echo "  Keep the apple_cognito_* sign-in keys separate from the uppercase APPLE_* billing keys." >&2
        return 1
    fi

    # The variables cognito-idp.tf and stripe.tf declare. A social provider
    # switches on in Terraform the moment its id is non-empty, so exporting a
    # stray TF_VAR_ would quietly try to create a provider with no
    # credentials.
    local known=" google_client_id google_client_secret \
facebook_app_id facebook_app_secret \
apple_cognito_services_id apple_cognito_team_id apple_cognito_key_id apple_cognito_private_key \
STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_MONTHLY STRIPE_PRICE_YEARLY \
APPLE_KEY_ID APPLE_ISSUER_ID APPLE_APP_ID APPLE_BUNDLE_ID APPLE_PRIVATE_KEY APPLE_ENV APPLE_PRODUCT_MONTHLY APPLE_PRODUCT_YEARLY "

    local loaded=() skipped=() key value
    while IFS= read -r key; do
        # A Windows-native jq.exe run under Git Bash text-mode-translates its
        # stdout, so every line - including key NAMES, not just the PEM value
        # below - comes back with a trailing CR that never matches $known.
        # Left unstripped, every key looks unrecognized and nothing exports.
        key="${key//$'\r'/}"
        if [[ "$known" != *" $key "* ]]; then
            skipped+=("$key")
            continue
        fi
        # jq -r turns the JSON \n escapes back into real newlines, which the
        # .p8 needs - Cognito rejects a private key that is one long line.
        value=$(printf '%s' "$json" | jq -r --arg k "$key" '.[$k]')
        # A key round-tripped through a Windows editor picks up CRs that make
        # the PEM unparseable in a way whose error message says nothing useful.
        value="${value//$'\r'/}"
        export "TF_VAR_$key=$value"
        loaded+=("$key")
    done < <(printf '%s' "$json" | jq -r 'keys[]')

    if [[ ${#loaded[@]} -eq 0 ]]; then
        echo "social-signin-env: no recognised keys in that secret." >&2
        [[ ${#skipped[@]} -gt 0 ]] && echo "  found instead: ${skipped[*]}" >&2
        return 1
    fi

    # Values are never echoed - only which variables are now set, and enough
    # shape for the .p8 to be checked at a glance.
    #
    # Built with a loop rather than ${loaded[*]/#/TF_VAR_}: that expansion
    # prefixes only the first element under zsh, which is what macOS starts
    # you in, and the resulting list is a lie about what was exported.
    local summary=""
    for key in "${loaded[@]}"; do
        summary="$summary TF_VAR_$key"
    done
    echo "Exported:$summary"
    if [[ -n "${TF_VAR_apple_cognito_private_key:-}" ]]; then
        local lines
        lines=$(printf '%s' "$TF_VAR_apple_cognito_private_key" | wc -l)
        if [[ "$TF_VAR_apple_cognito_private_key" != *"BEGIN PRIVATE KEY"* ]]; then
            echo "WARNING: apple_cognito_private_key has no BEGIN PRIVATE KEY line -" >&2
            echo "  paste the .p8 whole, header and footer included." >&2
        elif [[ "$lines" -lt 2 ]]; then
            echo "WARNING: apple_cognito_private_key is a single line - its newlines" >&2
            echo "  were lost. Store it with \\n escapes in the JSON secret." >&2
        else
            echo "  apple_cognito_private_key looks like a PEM ($((lines + 1)) lines)."
        fi
    fi
    if [[ ${#skipped[@]} -gt 0 ]]; then
        echo "Ignored (not a variable in cognito-idp.tf): ${skipped[*]}"
    fi
}

# Being executed rather than sourced means every export below would vanish
# with the subshell, and terraform would then see nothing at all.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "Source this file, don't run it:" >&2
    echo "  source ${BASH_SOURCE[0]}" >&2
    exit 1
fi

_bms_load_social_secret "$@"
