variable "aws_region" {
  description = "AWS region for regional resources (must match the ALB/ECS region)"
  type        = string
  default     = "us-west-1"
}

variable "account_id" {
  description = "AWS account ID"
  type        = string
  default     = "324752064997"
}

variable "domain_name" {
  description = "Root domain, registered manually (Terraform cannot purchase domains) before this config is applied"
  type        = string
  default     = "bettermusicsheet.com"
}

variable "api_subdomain" {
  description = "Subdomain the backend ALB is reachable on"
  type        = string
  default     = "api.bettermusicsheet.com"
}

variable "project" {
  description = "Common name prefix for new resources this phase creates"
  type        = string
  default     = "better-music-sheet"
}

# Existing resources this config reads but does not manage (created by hand
# earlier this project - see infra/README.md). Kept as variables rather than
# hardcoded so they're easy to spot/change in one place.
variable "existing_vpc_id" {
  type    = string
  default = "vpc-00e0cc64cbe3dbd12"
}

variable "existing_public_subnet_ids" {
  type    = list(string)
  default = ["subnet-02904cee45080e4e1", "subnet-055e0687f574cd01d"]
}

variable "existing_ecs_cluster_name" {
  type    = string
  default = "better-music-sheet-cluster"
}

variable "existing_web_bucket_name" {
  description = "The public S3 bucket the Next.js static export (better_music_sheet_web/) is deployed to - static website hosting already enabled by hand"
  type        = string
  default     = "better-music-sheet-web"
}
