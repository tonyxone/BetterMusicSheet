# Copy to backend.tf only when the separate state bucket exists and the state
# migration is authorized. This does not change backend configuration by default.
terraform {
  backend "s3" {}
}
