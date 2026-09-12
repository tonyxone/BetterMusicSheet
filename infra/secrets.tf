# The secret this backend signs its OWN tokens with (BACKEND_JWT_SECRET in
# ../auth.py). Unrelated to Cognito: Cognito's tokens are RS256-verified
# against its public JWKS, while ours are HS256 with this shared secret, so
# verifying a request never needs a network call.
#
# Generated here rather than typed in by hand, and delivered to the task as
# an ECS `secrets` entry (see ../taskdef-new.json) so the plaintext never
# appears in the task definition.
#
# NOTE: the generated value IS stored in plaintext in terraform.tfstate -
# that file is gitignored for this reason (see .gitignore). Rotating it
# invalidates every issued backend token, i.e. signs everyone out; they can
# just sign in again.

resource "random_password" "backend_jwt_secret" {
  length  = 64
  special = false
}

resource "aws_ssm_parameter" "backend_jwt_secret" {
  name        = "/${var.project}/backend-jwt-secret"
  description = "HS256 signing secret for the backend's own JWTs (auth.py)"
  type        = "SecureString"
  value       = random_password.backend_jwt_secret.result

  lifecycle {
    # Don't let a `terraform apply` silently rotate the secret (and sign
    # every user out) just because the random resource was recreated.
    ignore_changes = [value]
  }
}
