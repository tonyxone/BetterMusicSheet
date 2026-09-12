# Key layout (app-enforced convention, not declared here - S3 doesn't have
# a schema): music-sheet/input/{music_sheet_id}/ and
# music-sheet/output/{music_sheet_id}/. Deterministic from music_sheet_id
# alone, so DynamoDB doesn't need to store the path.
resource "aws_s3_bucket" "job_files" {
  bucket = "${var.project}-job-files"
}

resource "aws_s3_bucket_public_access_block" "job_files" {
  bucket = aws_s3_bucket.job_files.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "job_files" {
  bucket = aws_s3_bucket.job_files.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Jobs aren't cleaned up automatically today either, but unlike local disk,
# S3 storage costs money forever - cap it. 90 days is generous for
# "download your annotated PDF"; revisit if that turns out too short.
resource "aws_s3_bucket_lifecycle_configuration" "job_files" {
  bucket = aws_s3_bucket.job_files.id

  rule {
    id     = "expire-job-files"
    status = "Enabled"

    filter {}

    expiration {
      days = 90
    }
  }
}
