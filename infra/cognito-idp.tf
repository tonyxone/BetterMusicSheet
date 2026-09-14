# Social sign-in: Google, Apple and Facebook as Cognito identity providers.
#
# Each one is optional. A provider is created only once its credentials are
# supplied, so `terraform apply` keeps working before you have registered the
# app with Google/Apple/Meta - fill in one provider's variables at a time and
# apply again. The user pool client's supported_identity_providers list is
# built from the same conditions, so it never names a provider that does not
# exist yet (Cognito rejects that outright).
#
# DELIBERATELY NOT LINKED TO EXISTING ACCOUNTS. Cognito does not match a
# federated sign-in to a native one by email, so signing in with Google
# creates a SEPARATE pool user with its own `sub` - and `sub` is what this
# app files everything under (the user_id-index GSIs in dynamodb.tf, and the
# jobs/{user_id}/... prefixes in S3). Somebody who signed up with a password
# and later clicks "Continue with Google" therefore lands in a new, empty
# account rather than seeing their old sheets. That is an accepted trade-off,
# chosen over a PreSignUp trigger calling AdminLinkProviderForUser.

variable "google_client_id" {
  description = "Google OAuth client ID (console.cloud.google.com -> Credentials). Empty disables Google sign-in."
  type        = string
  default     = ""
}

variable "google_client_secret" {
  description = "Google OAuth client secret"
  type        = string
  default     = ""
  sensitive   = true
}

variable "facebook_app_id" {
  description = "Meta app ID (developers.facebook.com). Empty disables Facebook sign-in."
  type        = string
  default     = ""
}

variable "facebook_app_secret" {
  description = "Meta app secret"
  type        = string
  default     = ""
  sensitive   = true
}

variable "apple_services_id" {
  description = "Apple Services ID, e.g. com.bettermusicsheet.signin - NOT the app bundle id. Empty disables Apple sign-in."
  type        = string
  default     = ""
}

variable "apple_team_id" {
  description = "Apple Developer team ID (10 characters, top right of developer.apple.com)"
  type        = string
  default     = ""
}

variable "apple_key_id" {
  description = "Key ID of the Sign in with Apple private key"
  type        = string
  default     = ""
}

variable "apple_private_key" {
  description = "Contents of the .p8 private key downloaded from Apple, newlines included"
  type        = string
  default     = ""
  sensitive   = true
}

locals {
  google_enabled   = var.google_client_id != ""
  facebook_enabled = var.facebook_app_id != ""
  apple_enabled    = var.apple_services_id != ""

  # Cognito matches these names exactly, and they are also what the frontend
  # puts in the hosted UI's `identity_provider` query parameter.
  social_providers = concat(
    local.google_enabled ? ["Google"] : [],
    local.facebook_enabled ? ["Facebook"] : [],
    local.apple_enabled ? ["SignInWithApple"] : [],
  )
}

# `email` is mapped on every provider because the pool uses email as its
# username attribute (see cognito.tf) - without it Cognito has no username to
# create the federated user with. `name` is mapped so verify_cognito_id_token
# in ../auth.py finds a human name in the ID token rather than falling back to
# the email's local part.
resource "aws_cognito_identity_provider" "google" {
  count = local.google_enabled ? 1 : 0

  user_pool_id  = aws_cognito_user_pool.users.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = var.google_client_id
    client_secret    = var.google_client_secret
    authorize_scopes = "openid email profile"
  }

  attribute_mapping = {
    username = "sub"
    email    = "email"
    name     = "name"
  }
}

resource "aws_cognito_identity_provider" "facebook" {
  count = local.facebook_enabled ? 1 : 0

  user_pool_id  = aws_cognito_user_pool.users.id
  provider_name = "Facebook"
  provider_type = "Facebook"

  provider_details = {
    client_id        = var.facebook_app_id
    client_secret    = var.facebook_app_secret
    authorize_scopes = "public_profile,email"
    api_version      = "v17.0"
  }

  # Facebook's user identifier is `id`, not `sub`.
  attribute_mapping = {
    username = "id"
    email    = "email"
    name     = "name"
  }
}

# Apple is the awkward one: there is no client secret to paste. Cognito signs
# its own short-lived JWT with the .p8 key, which is why it needs the team and
# key ids as well.
#
# Apple also sends the user's name ONLY on the very first authorization, and
# omits it on every sign-in after that. db.save_user_identity (../db.py) writes
# only non-null values for exactly this reason, so the name captured the first
# time is not wiped out later.
resource "aws_cognito_identity_provider" "apple" {
  count = local.apple_enabled ? 1 : 0

  user_pool_id  = aws_cognito_user_pool.users.id
  provider_name = "SignInWithApple"
  provider_type = "SignInWithApple"

  provider_details = {
    client_id        = var.apple_services_id
    team_id          = var.apple_team_id
    key_id           = var.apple_key_id
    private_key      = var.apple_private_key
    authorize_scopes = "email name"
  }

  attribute_mapping = {
    username = "sub"
    email    = "email"
    name     = "name"
  }

  lifecycle {
    # Apple's .p8 is write-only as far as the API is concerned: Cognito never
    # returns it, so every plan would otherwise show a change and re-send it.
    ignore_changes = [provider_details["private_key"]]
  }
}

output "cognito_social_providers" {
  description = "Social providers currently configured on the user pool. Empty until credentials are supplied."
  value       = local.social_providers
}
