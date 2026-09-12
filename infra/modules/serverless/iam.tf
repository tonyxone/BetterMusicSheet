locals {
  lambda_assume = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" }
  }] })
  ecs_assume = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "ecs-tasks.amazonaws.com" }
  }] })
  logs_statement = {
    Effect   = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"],
    Resource = [for group in aws_cloudwatch_log_group.logs : "${group.arn}:*"]
  }
  db_statement = {
    Effect   = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:TransactWriteItems"],
    Resource = concat(local.table_arns, [for arn in local.table_arns : "${arn}/index/*"])
  }
  new_files_statement = {
    Effect   = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"],
    Resource = ["${aws_s3_bucket.files.arn}/jobs/*"]
  }
  list_files_statement = {
    Effect    = "Allow", Action = ["s3:ListBucket", "s3:ListBucketVersions"],
    Resource  = aws_s3_bucket.files.arn,
    Condition = { StringLike = { "s3:prefix" = ["jobs/*"] } }
  }
}

resource "aws_iam_role" "api" {
  name               = "${local.name}-api"
  assume_role_policy = local.lambda_assume
}
resource "aws_iam_role_policy" "api" {
  role = aws_iam_role.api.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    local.logs_statement, local.db_statement, local.new_files_statement, local.list_files_statement,
    { Effect = "Allow", Action = ["s3:GetObject", "s3:DeleteObject"], Resource = "arn:aws:s3:::${var.legacy_bucket}/*" },
    { Effect = "Allow", Action = ["s3:ListBucket"], Resource = "arn:aws:s3:::${var.legacy_bucket}" },
    { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = var.secret_parameter }
  ] })
}
resource "aws_iam_role" "controller" {
  name               = "${local.name}-controller"
  assume_role_policy = local.lambda_assume
}
resource "aws_iam_role_policy" "controller" {
  role = aws_iam_role.controller.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    local.logs_statement, local.db_statement, local.list_files_statement,
    { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:DeleteObject", "s3:DeleteObjectVersion"], Resource = "${aws_s3_bucket.files.arn}/jobs/*" },
    { Effect = "Allow", Action = ["sqs:SendMessage", "sqs:GetQueueAttributes"], Resource = aws_sqs_queue.jobs.arn },
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage"], Resource = aws_sqs_queue.failed.arn },
    { Effect = "Allow", Action = ["ecs:DescribeServices", "ecs:UpdateService"], Resource = "${replace(data.aws_ecs_cluster.existing.arn, ":cluster/", ":service/")}/${local.name}-worker" }
  ] })
}
resource "aws_iam_role" "worker" {
  name               = "${local.name}-worker"
  assume_role_policy = local.ecs_assume
}
resource "aws_iam_role_policy" "worker" {
  role = aws_iam_role.worker.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    local.db_statement,
    { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"], Resource = "${aws_s3_bucket.files.arn}/jobs/*" },
    { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.files.arn },
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"], Resource = aws_sqs_queue.jobs.arn },
    { Effect = "Allow", Action = ["ecs:GetTaskProtection", "ecs:UpdateTaskProtection"],
    Resource = "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task/${var.cluster_name}/*" }
  ] })
}
resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = local.ecs_assume
}
resource "aws_iam_role_policy" "execution" {
  role = aws_iam_role.execution.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    local.logs_statement,
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"],
    Resource = "arn:aws:ecr:${var.region}:${data.aws_caller_identity.current.account_id}:repository/*" }
  ] })
}
