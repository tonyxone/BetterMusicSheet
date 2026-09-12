provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "better-music-sheet"
      ManagedBy = "terraform"
    }
  }
}

# Amplify's own auto-provisioned cert for the apex/www domain is us-east-1
# regardless of app region; ACM certs for anything CloudFront-adjacent must
# live there. Not used by this phase's resources yet (the api.* cert is
# regional, alongside the ALB) but declared here so acm.tf can reference it
# later without a second `terraform init`.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "better-music-sheet"
      ManagedBy = "terraform"
    }
  }
}
