resource "aws_s3_bucket" "files" {
  bucket = "${local.name}-files-${data.aws_caller_identity.current.account_id}"
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_public_access_block" "files" {
  bucket                  = aws_s3_bucket.files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "files" {
  bucket = aws_s3_bucket.files.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_cors_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD", "POST"]
    allowed_origins = var.origins
    expose_headers  = ["ETag", "Content-Length", "Content-Disposition"]
    max_age_seconds = 300
  }
}
# Existing objects also need CORS for direct browser reads after cutover.
# Import/merge any pre-existing CORS configuration before applying this resource.
resource "aws_s3_bucket_cors_configuration" "legacy" {
  bucket = var.legacy_bucket
  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = var.origins
    expose_headers  = ["ETag", "Content-Length", "Content-Disposition"]
    max_age_seconds = 300
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    id     = "old-upload-versions"
    status = "Enabled"
    filter { prefix = "jobs/" }
    noncurrent_version_expiration { noncurrent_days = 14 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}
resource "aws_sqs_queue" "failed" {
  name                      = "${local.name}-failed"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}
resource "aws_sqs_queue" "jobs" {
  name                       = "${local.name}-jobs"
  message_retention_seconds  = 345600
  visibility_timeout_seconds = 180
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.failed.arn, maxReceiveCount = 5 })
}
resource "aws_sqs_queue_policy" "uploads" {
  queue_url = aws_sqs_queue.jobs.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect   = "Allow", Principal = { Service = "s3.amazonaws.com" }, Action = "sqs:SendMessage",
    Resource = aws_sqs_queue.jobs.arn,
    Condition = { ArnEquals = { "aws:SourceArn" = aws_s3_bucket.files.arn },
    StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
  }] })
}
resource "aws_s3_bucket_notification" "uploads" {
  bucket = aws_s3_bucket.files.id
  queue {
    queue_arn     = aws_sqs_queue.jobs.arn
    events        = ["s3:ObjectCreated:*"]
    filter_prefix = "jobs/"
    filter_suffix = "/input"
  }
  depends_on = [aws_sqs_queue_policy.uploads, aws_s3_bucket_versioning.files]
}
resource "aws_dynamodb_table" "control" {
  name         = "${local.name}-control"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "user_id"
  attribute {
    name = "user_id"
    type = "S"
  }
  point_in_time_recovery { enabled = true }
  lifecycle { prevent_destroy = true }
}
