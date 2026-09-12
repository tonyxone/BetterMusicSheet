data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# The app's own runtime permissions (S3 calls made BY server.py) - distinct
# from the existing task EXECUTION role, which only covers ECR pull +
# CloudWatch Logs at container-start time and is unrelated to app code.
resource "aws_iam_role" "ecs_task" {
  name               = "${var.project}-ecs-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

data "aws_iam_policy_document" "ecs_task_permissions" {
  # annotated-music-sheet is pre-existing (created by hand, originally meant
  # for static-site hosting, unused since - see infra/README.md), not
  # Terraform-managed, so referenced by literal ARN rather than a resource.
  # The Terraform-managed aws_s3_bucket.job_files (s3.tf) is no longer used
  # by the app - left defined/idle rather than destroyed.
  statement {
    sid    = "JobFilesBucketAccess"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = ["arn:aws:s3:::annotated-music-sheet/*"]
  }

  # Job/user state (db.py). The GSIs need their own ARNs - a table ARN does
  # not cover queries against its indexes.
  statement {
    sid    = "JobStateTableAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
    ]
    resources = [
      aws_dynamodb_table.users.arn,
      aws_dynamodb_table.music_sheet.arn,
      "${aws_dynamodb_table.music_sheet.arn}/index/*",
      aws_dynamodb_table.annotation_job.arn,
      "${aws_dynamodb_table.annotation_job.arn}/index/*",
    ]
  }
}

# Read-only access to the backend JWT secret, granted to the task EXECUTION
# role rather than the task role: ECS resolves a task definition's `secrets`
# entries itself, before the container starts, so it's the execution role
# that needs this - the app code never calls SSM. That role predates this
# config and isn't managed here (see infra/README.md), so the policy is
# attached to it by name.
data "aws_iam_policy_document" "read_backend_jwt_secret" {
  statement {
    sid       = "ReadBackendJwtSecret"
    effect    = "Allow"
    actions   = ["ssm:GetParameters"]
    resources = [aws_ssm_parameter.backend_jwt_secret.arn]
  }
}

resource "aws_iam_role_policy" "execution_read_backend_jwt_secret" {
  name   = "${var.project}-read-backend-jwt-secret"
  role   = var.existing_ecs_execution_role_name
  policy = data.aws_iam_policy_document.read_backend_jwt_secret.json
}

resource "aws_iam_role_policy" "ecs_task_permissions" {
  name   = "${var.project}-ecs-task-permissions"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.ecs_task_permissions.json
}
