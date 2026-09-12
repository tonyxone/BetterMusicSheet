# Stage the replacement alongside the current API. Both switches default off.
variable "enable_serverless" {
  type    = bool
  default = false
}

variable "serverless_api_image" {
  type    = string
  default = ""
}

variable "serverless_worker_image" {
  type    = string
  default = ""
}

variable "serverless_api_cutover" {
  type    = bool
  default = false
  validation {
    condition     = !var.serverless_api_cutover || var.enable_serverless
    error_message = "Enable and verify serverless resources before switching DNS."
  }
}

variable "serverless_max_workers" {
  type    = number
  default = 4
  validation {
    condition     = var.serverless_max_workers >= 1 && var.serverless_max_workers <= 16 && floor(var.serverless_max_workers) == var.serverless_max_workers
    error_message = "Use an integer worker cap from 1 to 16; higher capacity needs a quota/cost review."
  }
}

variable "serverless_spot_burst" {
  type    = bool
  default = false
}

# Cost alerts. Leave empty when an account-level budget already covers this.
variable "budget_email" {
  type    = string
  default = ""
}

# CloudWatch alarm notifications. Deliberately separate from budget_email: an
# alarm with no subscriber is silent, and whether anyone wants a second budget
# must not decide whether the queue-stuck and dead-letter alarms reach a person.
variable "alert_email" {
  type    = string
  default = ""
}

module "serverless" {
  count  = var.enable_serverless ? 1 : 0
  source = "./modules/serverless"

  project          = var.project
  region           = var.aws_region
  api_image        = var.serverless_api_image
  worker_image     = var.serverless_worker_image
  cluster_name     = var.existing_ecs_cluster_name
  vpc_id           = var.existing_vpc_id
  subnets          = var.existing_public_subnet_ids
  legacy_bucket    = "annotated-music-sheet"
  users_table      = aws_dynamodb_table.users.name
  sheets_table     = aws_dynamodb_table.music_sheet.name
  jobs_table       = aws_dynamodb_table.annotation_job.name
  secret_parameter = aws_ssm_parameter.backend_jwt_secret.arn
  cognito_pool     = aws_cognito_user_pool.users.id
  cognito_client   = aws_cognito_user_pool_client.web.id
  api_domain       = var.api_subdomain
  certificate_arn  = aws_acm_certificate_validation.api.certificate_arn
  origins          = ["https://${var.domain_name}", "https://www.${var.domain_name}", "http://localhost:3000"]
  max_workers      = var.serverless_max_workers
  spot_burst       = var.serverless_spot_burst
  alert_email      = var.alert_email
}

resource "aws_budgets_budget" "monthly" {
  count        = var.budget_email == "" ? 0 : 1
  name         = "${var.project}-monthly"
  budget_type  = "COST"
  limit_amount = "100"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  dynamic "notification" {
    for_each = [25, 50, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      notification_type          = "ACTUAL"
      threshold                  = notification.value
      threshold_type             = "ABSOLUTE_VALUE"
      subscriber_email_addresses = [var.budget_email]
    }
  }
}

output "serverless_api_url" {
  value = var.enable_serverless ? module.serverless[0].api_url : null
}
output "serverless_api_function" {
  value = var.enable_serverless ? module.serverless[0].api_function : null
}
output "serverless_controller_function" {
  value = var.enable_serverless ? module.serverless[0].controller_function : null
}
output "serverless_worker_service" {
  value = var.enable_serverless ? module.serverless[0].worker_service : null
}
output "serverless_alerts_topic" {
  description = "Confirm the emailed subscription on this topic, or the alarms are silent"
  value       = var.enable_serverless ? module.serverless[0].alerts_topic : null
}
