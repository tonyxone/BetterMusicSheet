variable "project" { type = string }
variable "region" { type = string }
# Appended to every resource name. Empty for the original (us-west-1) copy,
# so none of its resources are renamed; set for any other region's copy,
# since IAM roles and S3 bucket names are global and would otherwise collide.
variable "suffix" {
  type    = string
  default = ""
}
# The user pool lives in one region; this copy of the API may run in another
# (see ../../auth.py, which otherwise assumes its own region).
variable "cognito_region" { type = string }
# Where jobs that don't record a region keep their files: every job from before
# the service ran in two regions, and every legacy sheet (see ../../storage.py).
variable "files_home_region" { type = string }
variable "files_home_bucket" {
  type    = string
  default = ""
}
# Other regions' job-file buckets. A visitor may be routed to this region for a
# sheet uploaded in another, so the API can read, write edits to, and delete
# files there too. The worker and controller only ever touch their own bucket.
variable "other_file_buckets" {
  type    = list(string)
  default = []
}
# The legacy bucket's CORS rules belong to exactly one copy of this module.
variable "manage_legacy_cors" {
  type    = bool
  default = true
}
variable "api_image" {
  type = string
  validation {
    condition     = length(var.api_image) > 0
    error_message = "Build and push the API image before enabling serverless infrastructure."
  }
}
variable "worker_image" {
  type = string
  validation {
    condition     = length(var.worker_image) > 0
    error_message = "Build and push the worker image before enabling serverless infrastructure."
  }
}
variable "cluster_name" { type = string }
variable "vpc_id" { type = string }
variable "subnets" { type = list(string) }
variable "legacy_bucket" { type = string }
variable "users_table" { type = string }
variable "subscriptions_table" { type = string }
variable "master_users_table" { type = string }
variable "sheets_table" { type = string }
variable "jobs_table" { type = string }
variable "secret_parameter" { type = string }
variable "cognito_pool" { type = string }
variable "cognito_client" { type = string }
# Hosted-UI base URL. The API needs it to trade a social sign-in's
# authorization code for tokens at {domain}/oauth2/token - see ../../auth.py.
variable "cognito_domain" { type = string }
variable "api_domain" { type = string }
variable "certificate_arn" { type = string }
variable "origins" { type = list(string) }
variable "max_workers" { type = number }
variable "spot_burst" { type = bool }
variable "alert_email" { type = string }
# Only api reads these (see stripe_billing.py) - kept off local.environment
# below and out of controller/worker for the same reason COGNITO_DOMAIN is
# scoped to api alone in compute.tf: a component gets a secret only if it
# actually has a use for it, not merely because the shared map is convenient.
variable "stripe_secret_key" {
  type      = string
  sensitive = true
}
variable "stripe_webhook_secret" {
  type      = string
  sensitive = true
}
variable "stripe_price_monthly" { type = string }
variable "stripe_price_yearly" { type = string }

data "aws_caller_identity" "current" {}
data "aws_ecs_cluster" "existing" { cluster_name = var.cluster_name }

locals {
  name = "${var.project}-v2${var.suffix}"
  environment = {
    APP_ENV               = "production"
    COGNITO_REGION        = var.cognito_region
    FILES_HOME_REGION     = var.files_home_region
    FILES_HOME_BUCKET     = var.files_home_bucket != "" ? var.files_home_bucket : aws_s3_bucket.files.id
    JOB_BACKEND           = "sqs"
    JOB_FILES_BUCKET      = var.legacy_bucket
    NEW_JOB_FILES_BUCKET  = aws_s3_bucket.files.id
    USERS_TABLE           = var.users_table
    SUBSCRIPTIONS_TABLE   = var.subscriptions_table
    MASTER_USERS_TABLE    = var.master_users_table
    STRIPE_PRICE_MONTHLY  = var.stripe_price_monthly
    STRIPE_PRICE_YEARLY   = var.stripe_price_yearly
    MUSIC_SHEET_TABLE     = var.sheets_table
    ANNOTATION_JOB_TABLE  = var.jobs_table
    JOB_CONTROL_TABLE     = aws_dynamodb_table.control.name
    JOB_QUEUE_URL         = aws_sqs_queue.jobs.url
    JOB_DLQ_URL           = aws_sqs_queue.failed.url
    ALLOWED_ORIGINS       = join(",", var.origins)
    COGNITO_USER_POOL_ID  = var.cognito_pool
    COGNITO_APP_CLIENT_ID = var.cognito_client
    MAX_UPLOAD_BYTES      = "26214400"
    MAX_PAGES             = "50"
    MAX_JOB_SECONDS       = "1800"
  }
  table_arns = [for name in [var.users_table, var.subscriptions_table, var.sheets_table, var.jobs_table, aws_dynamodb_table.control.name] :
  "arn:aws:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/${name}"]
}
