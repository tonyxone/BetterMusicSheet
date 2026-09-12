variable "project" { type = string }
variable "region" { type = string }
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
variable "sheets_table" { type = string }
variable "jobs_table" { type = string }
variable "secret_parameter" { type = string }
variable "cognito_pool" { type = string }
variable "cognito_client" { type = string }
variable "api_domain" { type = string }
variable "certificate_arn" { type = string }
variable "origins" { type = list(string) }
variable "max_workers" { type = number }
variable "spot_burst" { type = bool }
variable "alert_email" { type = string }

data "aws_caller_identity" "current" {}
data "aws_ecs_cluster" "existing" { cluster_name = var.cluster_name }

locals {
  name = "${var.project}-v2"
  environment = {
    APP_ENV               = "production"
    JOB_BACKEND           = "sqs"
    JOB_FILES_BUCKET      = var.legacy_bucket
    NEW_JOB_FILES_BUCKET  = aws_s3_bucket.files.id
    USERS_TABLE           = var.users_table
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
  table_arns = [for name in [var.users_table, var.sheets_table, var.jobs_table, aws_dynamodb_table.control.name] :
  "arn:aws:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/${name}"]
}
