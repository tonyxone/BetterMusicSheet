# Job/user state (see ../db.py). PAY_PER_REQUEST throughout: traffic is
# low and spiky, and provisioned capacity would cost money while idle.
#
# The music_sheet/annotation_job tables hold rows for guests AND signed-in
# users - user_id is whichever id identified the request. Only `users` is
# exclusively real accounts.
#
# With enable_us_east_1, every table here becomes a global table with a
# replica in us-east-1 (see us-east-1.tf). Replication needs a stream carrying
# both images; DynamoDB resolves concurrent writes to one item in two regions
# by keeping the last one, which suits these tables: each row is written by
# the region that is serving its user at the time. The per-region upload lock
# (the module's `control` table) is deliberately NOT replicated.

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

  stream_enabled   = local.us_east_1_enabled
  stream_view_type = local.us_east_1_enabled ? "NEW_AND_OLD_IMAGES" : null
  dynamic "replica" {
    for_each = local.us_east_1_enabled ? [local.us_east_1] : []
    content {
      region_name            = replica.value
      point_in_time_recovery = true
    }
  }
}

resource "aws_dynamodb_table" "subscriptions" {
  name         = "${var.project}-subscriptions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "user_id"

  attribute {
    name = "user_id"
    type = "S"
  }

  attribute {
    name = "subscription_id"
    type = "S"
  }

  # Apple notifications and restores name a subscription, not an account, so
  # the owner is looked up by the provider's id (see ../db.py).
  global_secondary_index {
    name            = "subscription_id-index"
    hash_key        = "subscription_id"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  stream_enabled   = local.us_east_1_enabled
  stream_view_type = local.us_east_1_enabled ? "NEW_AND_OLD_IMAGES" : null
  dynamic "replica" {
    for_each = local.us_east_1_enabled ? [local.us_east_1] : []
    content {
      region_name            = replica.value
      point_in_time_recovery = true
    }
  }
}

# Accounts that bypass every subscription check in the web and iOS apps (see
# ../auth.py get_entitlement). user_id (the Cognito `sub`) is the only field -
# a row's presence is the grant. Rows are managed by hand, e.g.
#   aws dynamodb put-item --table-name <name> --item '{"user_id":{"S":"<sub>"}}'
resource "aws_dynamodb_table" "master_user" {
  name         = "${var.project}-master-user"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "user_id"

  attribute {
    name = "user_id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  stream_enabled   = local.us_east_1_enabled
  stream_view_type = local.us_east_1_enabled ? "NEW_AND_OLD_IMAGES" : null
  dynamic "replica" {
    for_each = local.us_east_1_enabled ? [local.us_east_1] : []
    content {
      region_name            = replica.value
      point_in_time_recovery = true
    }
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

  stream_enabled   = local.us_east_1_enabled
  stream_view_type = local.us_east_1_enabled ? "NEW_AND_OLD_IMAGES" : null
  dynamic "replica" {
    for_each = local.us_east_1_enabled ? [local.us_east_1] : []
    content {
      region_name            = replica.value
      point_in_time_recovery = true
    }
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

  stream_enabled   = local.us_east_1_enabled
  stream_view_type = local.us_east_1_enabled ? "NEW_AND_OLD_IMAGES" : null
  dynamic "replica" {
    for_each = local.us_east_1_enabled ? [local.us_east_1] : []
    content {
      region_name            = replica.value
      point_in_time_recovery = true
    }
  }
}
