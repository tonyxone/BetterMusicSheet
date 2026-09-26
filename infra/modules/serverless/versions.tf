# Declared so the root can hand this module a provider for another region
# (see ../../us-east-1.tf).
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}
