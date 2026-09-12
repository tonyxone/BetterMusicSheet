# Job/user state (see ../db.py). PAY_PER_REQUEST throughout: traffic is
# low and spiky, and provisioned capacity would cost money while idle.
#
# The music_sheet/annotation_job tables hold rows for guests AND signed-in
# users - user_id is whichever id identified the request. Only `users` is
# exclusively real accounts.

resource "aws_dynamodb_table" "users" {
  name         = "${var.project}-users"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "user_id"

  # user_id is the Cognito `sub`. Written once at first sign-in
  # (create_user_if_missing) and read on every /api/me, so no index needed.
  attribute {
    name = "user_id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_dynamodb_table" "music_sheet" {
  name         = "${var.project}-music-sheet"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "music_sheet_id"

  attribute {
    name = "music_sheet_id"
    type = "S"
  }

  attribute {
    name = "user_id"
    type = "S"
  }

  attribute {
    name = "created_at"
    type = "N"
  }

  # Every per-user listing goes through this index rather than a table scan.
  # created_at as the range key is what lets db.py read newest-first with
  # ScanIndexForward=false instead of sorting in Python.
  global_secondary_index {
    name            = "user_id-index"
    hash_key        = "user_id"
    range_key       = "created_at"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_dynamodb_table" "annotation_job" {
  name         = "${var.project}-annotation-job"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "job_id"

  attribute {
    name = "job_id"
    type = "S"
  }

  attribute {
    name = "user_id"
    type = "S"
  }

  attribute {
    name = "created_at"
    type = "N"
  }

  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "next_check_at"
    type = "N"
  }

  # Sparse: only v2 jobs needing reconciliation have next_check_at.
  global_secondary_index {
    name            = "work-index"
    hash_key        = "status"
    range_key       = "next_check_at"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "user_id-index"
    hash_key        = "user_id"
    range_key       = "created_at"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }
}
