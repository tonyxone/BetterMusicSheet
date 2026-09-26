# A second copy of the serverless stack in us-east-1, for speed (visitors are
# routed to the nearer region) and availability (a region that fails its
# health check stops receiving traffic). See ../docs/second-region.md.
#
# What is shared and what is per region:
#   - DynamoDB tables: global tables, one replica per region (dynamodb.tf).
#     The upload lock (the module's `control` table) stays per region.
#   - Job files: a bucket per region. A job records which one holds its
#     files, and any region's API can serve it (../storage.py).
#   - Queue, worker, controller: per region; each handles its own jobs only.
#   - Cognito: one user pool, in us-west-1 - it cannot be replicated.
#   - The backend's JWT secret: copied, so a session works in both regions.
#
# Rollout is two releases, because a Lambda can only run an image from its own
# region's ECR and replication only copies images pushed after it is set up:
#   1. Merge with enable_us_east_1 = false. The release sets up the ECR
#      repository and replication below and nothing else.
#   2. Set enable_us_east_1 = true and release again. That release's images
#      replicate (the workflow waits for them), and the apply creates the rest.
variable "enable_us_east_1" {
  type    = bool
  default = false
}

locals {
  us_east_1         = "us-east-1"
  us_east_1_enabled = var.enable_serverless && var.enable_us_east_1
  us_east_1_count   = local.us_east_1_enabled ? 1 : 0
  # Must match the bucket name modules/serverless/storage.tf derives, which
  # isn't read from the module's output because each region's copy needs the
  # other's name - and module outputs would make that a dependency cycle.
  us_west_1_files_bucket = "${var.project}-v2-files-${var.account_id}"
  us_east_1_files_bucket = "${var.project}-v2-use1-files-${var.account_id}"
}

# ---- container images (set up in step 1, before the flag) ----

resource "aws_ecr_repository" "us_east_1" {
  provider             = aws.us_east_1
  name                 = var.existing_ecr_repository_name
  image_tag_mutability = "MUTABLE" # the release workflow retags `latest`
}

resource "aws_ecr_lifecycle_policy" "us_east_1" {
  provider   = aws.us_east_1
  repository = aws_ecr_repository.us_east_1.name
  policy     = local.ecr_lifecycle_policy
}

# Lambda pulls a function's image with its own service identity. Creating a
# function from the console adds this grant on the fly; declare it instead.
resource "aws_ecr_repository_policy" "us_east_1" {
  provider   = aws.us_east_1
  repository = aws_ecr_repository.us_east_1.name
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Sid       = "LambdaPull"
    Effect    = "Allow"
    Principal = { Service = "lambda.amazonaws.com" }
    Action    = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    Condition = { StringLike = { "aws:sourceArn" = "arn:aws:lambda:${local.us_east_1}:${var.account_id}:function:*" } }
  }] })
}

# Registry-wide: the account can have only one replication configuration.
resource "aws_ecr_replication_configuration" "images" {
  replication_configuration {
    rule {
      destination {
        region      = local.us_east_1
        registry_id = var.account_id
      }
      repository_filter {
        filter      = var.existing_ecr_repository_name
        filter_type = "PREFIX_MATCH"
      }
    }
  }
  depends_on = [aws_ecr_repository.us_east_1]
}

# ---- network and cluster for the worker ----
#
# Public subnets and no NAT gateway, like the us-west-1 worker: the tasks only
# make outbound calls, and a NAT gateway would cost more than everything else
# in this region put together.

# Fargate can't place tasks in use1-az3.
data "aws_availability_zones" "us_east_1" {
  count    = local.us_east_1_count
  provider = aws.us_east_1
  state    = "available"
  filter {
    name   = "zone-id"
    values = ["use1-az1", "use1-az2", "use1-az4", "use1-az5", "use1-az6"]
  }
}

resource "aws_vpc" "us_east_1" {
  count                = local.us_east_1_count
  provider             = aws.us_east_1
  cidr_block           = "10.40.0.0/16"
  enable_dns_hostnames = true
  tags                 = { Name = "${var.project}-use1" }
}

resource "aws_internet_gateway" "us_east_1" {
  count    = local.us_east_1_count
  provider = aws.us_east_1
  vpc_id   = aws_vpc.us_east_1[0].id
  tags     = { Name = "${var.project}-use1" }
}

resource "aws_subnet" "us_east_1" {
  count                   = local.us_east_1_enabled ? 2 : 0
  provider                = aws.us_east_1
  vpc_id                  = aws_vpc.us_east_1[0].id
  availability_zone       = data.aws_availability_zones.us_east_1[0].names[count.index]
  cidr_block              = cidrsubnet(aws_vpc.us_east_1[0].cidr_block, 8, count.index)
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.project}-use1-public-${count.index}" }
}

resource "aws_route_table" "us_east_1" {
  count    = local.us_east_1_count
  provider = aws.us_east_1
  vpc_id   = aws_vpc.us_east_1[0].id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.us_east_1[0].id
  }
  tags = { Name = "${var.project}-use1-public" }
}

resource "aws_route_table_association" "us_east_1" {
  count          = length(aws_subnet.us_east_1)
  provider       = aws.us_east_1
  subnet_id      = aws_subnet.us_east_1[count.index].id
  route_table_id = aws_route_table.us_east_1[0].id
}

resource "aws_ecs_cluster" "us_east_1" {
  count    = local.us_east_1_count
  provider = aws.us_east_1
  name     = "${var.project}-use1-cluster"
}

resource "aws_ecs_cluster_capacity_providers" "us_east_1" {
  count              = local.us_east_1_count
  provider           = aws.us_east_1
  cluster_name       = aws_ecs_cluster.us_east_1[0].name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

# ---- the backend's JWT secret ----
#
# Copied from the live us-west-1 value, not from random_password: that
# parameter ignores changes to its value, so the two can differ, and a session
# must verify in whichever region a request lands. A hand rotation reaches
# this copy with the next release's apply.
data "aws_ssm_parameter" "backend_jwt_secret" {
  count           = local.us_east_1_count
  name            = aws_ssm_parameter.backend_jwt_secret.name
  with_decryption = true
}

resource "aws_ssm_parameter" "backend_jwt_secret_us_east_1" {
  count       = local.us_east_1_count
  provider    = aws.us_east_1
  name        = aws_ssm_parameter.backend_jwt_secret.name
  description = "Copy of the us-west-1 parameter of the same name (see us-east-1.tf)"
  type        = "SecureString"
  value       = data.aws_ssm_parameter.backend_jwt_secret[0].value
}

# ---- api.* certificate (API Gateway needs one in its own region) ----

resource "aws_acm_certificate" "api_us_east_1" {
  count             = local.us_east_1_count
  provider          = aws.us_east_1
  domain_name       = var.api_subdomain
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}

# ACM may hand out the same validation record as the us-west-1 certificate's,
# hence allow_overwrite. If the two are the same record, destroying this one
# removes it from DNS; the next apply puts it back, since acm.tf still owns it.
resource "aws_route53_record" "api_cert_validation_us_east_1" {
  for_each = local.us_east_1_enabled ? {
    for dvo in aws_acm_certificate.api_us_east_1[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  zone_id         = data.aws_route53_zone.root.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "api_us_east_1" {
  count                   = local.us_east_1_count
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.api_us_east_1[0].arn
  validation_record_fqdns = [for r in aws_route53_record.api_cert_validation_us_east_1 : r.fqdn]
}

# ---- the stack ----

module "serverless_us_east_1" {
  count     = local.us_east_1_count
  source    = "./modules/serverless"
  providers = { aws = aws.us_east_1 }

  project = var.project
  region  = local.us_east_1
  suffix  = "-use1"
  # Replicated from us-west-1's ECR - the workflow waits for these tags to
  # arrive before applying (see release.yml).
  api_image             = replace(var.serverless_api_image, ".dkr.ecr.${var.aws_region}.", ".dkr.ecr.${local.us_east_1}.")
  worker_image          = replace(var.serverless_worker_image, ".dkr.ecr.${var.aws_region}.", ".dkr.ecr.${local.us_east_1}.")
  cluster_name          = aws_ecs_cluster.us_east_1[0].name
  vpc_id                = aws_vpc.us_east_1[0].id
  subnets               = aws_subnet.us_east_1[*].id
  legacy_bucket         = "annotated-music-sheet"
  manage_legacy_cors    = false
  files_home_region     = var.aws_region
  files_home_bucket     = local.us_west_1_files_bucket
  other_file_buckets    = [local.us_west_1_files_bucket]
  users_table           = aws_dynamodb_table.users.name
  subscriptions_table   = aws_dynamodb_table.subscriptions.name
  master_users_table    = aws_dynamodb_table.master_user.name
  sheets_table          = aws_dynamodb_table.music_sheet.name
  jobs_table            = aws_dynamodb_table.annotation_job.name
  secret_parameter      = aws_ssm_parameter.backend_jwt_secret_us_east_1[0].arn
  cognito_region        = var.aws_region
  cognito_pool          = aws_cognito_user_pool.users.id
  cognito_client        = aws_cognito_user_pool_client.web.id
  cognito_domain        = "https://${aws_cognito_user_pool_domain.users.domain}.auth.${var.aws_region}.amazoncognito.com"
  api_domain            = var.api_subdomain
  certificate_arn       = aws_acm_certificate_validation.api_us_east_1[0].certificate_arn
  origins               = ["https://${var.domain_name}", "https://www.${var.domain_name}", "http://localhost:3000"]
  max_workers           = var.serverless_max_workers
  spot_burst            = var.serverless_spot_burst
  alert_email           = var.alert_email
  stripe_secret_key     = var.STRIPE_SECRET_KEY
  stripe_webhook_secret = var.STRIPE_WEBHOOK_SECRET
  stripe_price_monthly  = var.STRIPE_PRICE_MONTHLY
  stripe_price_yearly   = var.STRIPE_PRICE_YEARLY

  # The Lambdas read the tables' us-east-1 replicas from their first request.
  depends_on = [
    aws_dynamodb_table.users, aws_dynamodb_table.subscriptions, aws_dynamodb_table.master_user,
    aws_dynamodb_table.music_sheet, aws_dynamodb_table.annotation_job,
    aws_ecs_cluster_capacity_providers.us_east_1, aws_route_table_association.us_east_1,
  ]
}

# ---- routing: nearest healthy region ----
#
# Each region's api.* record (route53.tf and below) answers the visitors with
# the lowest latency to it, as long as its health check passes. Three checker
# regions is the minimum Route 53 allows; every check is a real Lambda call,
# so more would only add cost.
resource "aws_route53_health_check" "api" {
  for_each = local.us_east_1_enabled ? {
    (var.aws_region)  = module.serverless[0].api_url
    (local.us_east_1) = module.serverless_us_east_1[0].api_url
  } : {}

  fqdn              = trimprefix(each.value, "https://")
  port              = 443
  type              = "HTTPS"
  resource_path     = "/api/health"
  request_interval  = 30
  failure_threshold = 3
  regions           = ["us-west-1", "us-east-1", "us-west-2"]
  tags              = { Name = "${var.project}-api-${each.key}" }
}

resource "aws_route53_record" "api_us_east_1" {
  count           = local.us_east_1_count
  zone_id         = data.aws_route53_zone.root.zone_id
  name            = var.api_subdomain
  type            = "A"
  set_identifier  = local.us_east_1
  health_check_id = aws_route53_health_check.api[local.us_east_1].id
  latency_routing_policy {
    region = local.us_east_1
  }
  alias {
    name                   = module.serverless_us_east_1[0].domain_target
    zone_id                = module.serverless_us_east_1[0].domain_zone
    evaluate_target_health = false
  }
  # A latency record can't coexist with the plain record it replaces, so wait
  # for route53.tf's record to become a latency record first.
  depends_on = [aws_route53_record.api]
}

output "us_east_1_enabled" { value = local.us_east_1_enabled }
output "us_east_1_api_function" {
  value = local.us_east_1_enabled ? module.serverless_us_east_1[0].api_function : null
}
output "us_east_1_controller_function" {
  value = local.us_east_1_enabled ? module.serverless_us_east_1[0].controller_function : null
}
output "us_east_1_cluster" {
  value = local.us_east_1_enabled ? aws_ecs_cluster.us_east_1[0].name : null
}
output "us_east_1_worker_service" {
  value = local.us_east_1_enabled ? module.serverless_us_east_1[0].worker_service : null
}
output "us_east_1_alerts_topic" {
  description = "Confirm the emailed subscription on this topic too, or us-east-1's alarms are silent"
  value       = local.us_east_1_enabled ? module.serverless_us_east_1[0].alerts_topic : null
}
