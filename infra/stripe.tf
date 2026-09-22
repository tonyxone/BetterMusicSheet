# Stripe billing credentials for the API/controller Lambdas (server.py's
# stripe_billing.py). Loaded the same way as the Cognito social sign-in
# credentials in cognito-idp.tf - out of the same Secrets Manager secret, via
#
#   source infra/social-signin-env.sh
#   terraform -chdir=infra apply -var-file=serverless.tfvars
#
# - so none of these ever sit in a .tfvars file or a CI log. STRIPE_PRICE_
# MONTHLY/YEARLY are Stripe Price ids, not secrets, but travel the same way
# for convenience since they already live in that one secret alongside the
# real ones.
#
# Named to match the environment variable server.py actually reads
# (config.py's STRIPE_SECRET_KEY etc.) rather than Terraform's usual
# lower_snake_case: these pass straight through into the Lambda environment
# with no translation, unlike the Cognito variables, which only ever
# configure a Cognito resource and never become an application environment
# variable at all.

variable "STRIPE_SECRET_KEY" {
  description = "Stripe secret API key (sk_...). Empty disables billing - see stripe_billing.py's _require."
  type        = string
  default     = ""
  sensitive   = true
}

variable "STRIPE_WEBHOOK_SECRET" {
  description = "Signing secret for the Stripe webhook endpoint (whsec_...)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "STRIPE_PRICE_MONTHLY" {
  description = "Stripe Price id (price_...) for the monthly plan - a Payment Link id (plink_...) will 500 at checkout"
  type        = string
  default     = ""
}

variable "STRIPE_PRICE_YEARLY" {
  description = "Stripe Price id (price_...) for the yearly plan - a Payment Link id (plink_...) will 500 at checkout"
  type        = string
  default     = ""
}
