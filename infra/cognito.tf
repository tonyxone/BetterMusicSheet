# Cognito user pool for optional sign-in. The app works signed-out (an
# anonymous per-browser guest id, see ../auth.py), so nothing here is on the
# critical path for uploading - it exists so a visitor CAN have a durable
# identity, and so their files are stored under a real user id.

resource "aws_cognito_user_pool" "users" {
  name = "${var.project}-users"

  # Email is the login handle and the one thing we always want back in the
  # ID token; `name` is optional (the backend falls back to the email's
  # local part when a user has none - see verify_cognito_id_token).
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true

    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }

  schema {
    name                = "name"
    attribute_data_type = "String"
    required            = false
    mutable             = true

    string_attribute_constraints {
      min_length = 0
      max_length = 256
    }
  }

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_uppercase = true
    require_symbols   = false
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

# The hosted UI lives at https://{domain}.auth.{region}.amazoncognito.com -
# that full URL is what the frontend's NEXT_PUBLIC_COGNITO_DOMAIN needs (see
# the cognito_hosted_ui_domain output).
resource "aws_cognito_user_pool_domain" "users" {
  domain       = var.project
  user_pool_id = aws_cognito_user_pool.users.id
}

# A PUBLIC client: no secret. The frontend is a static export served from
# S3/CloudFront with no server side of its own (see
# ../better_music_sheet_web/next.config.ts), so there is nowhere to keep a
# client secret - which is exactly the case authorization-code + PKCE is
# for. generate_secret must stay false or the browser flow cannot complete.
resource "aws_cognito_user_pool_client" "web" {
  name         = "${var.project}-web"
  user_pool_id = aws_cognito_user_pool.users.id

  generate_secret = false

  # The app signs people in through its own modal (see
  # ../better_music_sheet_web/app/sign-in-modal.tsx), calling Cognito's API
  # directly rather than redirecting to the hosted UI - Cognito's page can't
  # be themed to match the site or given a close button, and it can't be
  # framed (X-Frame-Options: DENY).
  #
  # USER_PASSWORD_AUTH sends the password to Cognito over TLS instead of
  # doing the SRP exchange in the browser. That's the documented trade-off
  # for not shipping an SRP implementation; the password still only ever
  # goes to Cognito, never to this project's backend.
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  # The hosted-UI OAuth settings below are kept so the redirect flow still
  # works (nothing in the app uses it today) - harmless, and removing them
  # would mean re-registering callback URLs to ever go back.
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  # Cognito matches these by exact string. The trailing slash is required:
  # next.config.ts sets trailingSlash, so the exported page really is at
  # /auth/callback/ (see lib/auth.ts's callbackUrl).
  callback_urls = [
    "https://${var.domain_name}/auth/callback/",
    "https://www.${var.domain_name}/auth/callback/",
    "http://localhost:3000/auth/callback/",
  ]

  logout_urls = [
    "https://${var.domain_name}/",
    "https://www.${var.domain_name}/",
    "http://localhost:3000/",
  ]

  # The ID token is exchanged for this backend's own token immediately and
  # never used again (see ../auth.py), so it only has to outlive one
  # redirect. The refresh token is what actually keeps a session alive:
  # lib/auth.ts uses it to re-mint without sending the user back to Cognito.
  id_token_validity      = 1
  access_token_validity  = 1
  refresh_token_validity = 30

  token_validity_units {
    id_token      = "hours"
    access_token  = "hours"
    refresh_token = "days"
  }

  # Returning "user not found" on sign-in tells an attacker which emails are
  # registered; ENABLED makes Cognito answer identically either way.
  prevent_user_existence_errors = "ENABLED"
}

# Restyle the hosted UI to match the app's paper/ink theme - otherwise
# sign-in is a jarring hand-off from the site to a stock grey-and-blue
# Cognito form.
#
# This is the CLASSIC hosted UI's customization API, which accepts an
# ALLOWLIST of CSS classes and properties, not arbitrary CSS - anything
# outside it is rejected at apply time. In particular there is no way to set
# a font or restructure the layout here, so this matches colors, weights and
# spacing only. Applies to every client in the pool (no client_id set).
#
# Requires the user pool domain above to exist first; Terraform infers that
# ordering from the user_pool_id reference.
resource "aws_cognito_user_pool_ui_customization" "hosted_ui" {
  user_pool_id = aws_cognito_user_pool_domain.users.user_pool_id

  css = <<-CSS
    .background-customizable {
      background-color: #FAF3E6;
    }
    .banner-customizable {
      padding: 25px 0px 25px 10px;
      background-color: #F0E4CE;
    }
    .label-customizable {
      font-weight: 600;
      color: #2E2117;
    }
    .textDescription-customizable {
      padding-top: 10px;
      padding-bottom: 10px;
      display: block;
      font-size: 16px;
      color: #2E2117;
    }
    .idpDescription-customizable {
      padding-top: 10px;
      padding-bottom: 10px;
      display: block;
      font-size: 16px;
      color: #7A6753;
    }
    .legalText-customizable {
      color: #7A6753;
      font-size: 11px;
    }
    .submitButton-customizable {
      font-size: 14px;
      font-weight: bold;
      margin: 20px 0px 10px 0px;
      height: 44px;
      width: 100%;
      color: #FFFFFF;
      background-color: #A83C34;
    }
    .submitButton-customizable:hover {
      color: #FFFFFF;
      background-color: #8C4A1F;
    }
    .errorMessage-customizable {
      padding: 5px;
      font-size: 14px;
      width: 100%;
      background: #F5E3E1;
      border: 2px solid #A83C34;
      color: #A83C34;
    }
    .inputField-customizable {
      width: 100%;
      height: 40px;
      color: #2E2117;
      background-color: #FFFDF8;
      border: 1px solid #D8C7A8;
    }
    .inputField-customizable:focus {
      border-color: #A83C34;
      outline: 0;
    }
    .redirect-customizable {
      text-align: center;
      padding-top: 10px;
    }
    .passwordCheck-notValid-customizable {
      color: #A83C34;
    }
    .passwordCheck-valid-customizable {
      color: #5C7A4E;
    }
  CSS
}
