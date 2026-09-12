terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }

    # Generates the backend JWT signing secret (see secrets.tf).
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Local state to start, remote before the serverless migration. Copy
  # backend.tf.example/backend.hcl.example and migrate - see
  # ../docs/serverless-migration.md. Left out of this file so the first
  # `terraform init` on a fresh checkout stays backend-free.
}
