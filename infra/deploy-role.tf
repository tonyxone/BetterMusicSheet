# What the GitHub Actions deploy role is allowed to touch.
#
# The role itself predates this config and is deliberately not managed here
# (see README), but its permissions have to track the stack: they were still
# scoped to the ECS API service and task role that the migration deleted, and
# granted nothing on Lambda at all, so the first release after cutover failed
# with AccessDenied before it changed anything. Attaching the policy by role
# name keeps the role out of scope while keeping the grant honest.
variable "github_deploy_role_name" {
  type    = string
  default = "github-actions-sheet-annotator"
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "PushImages"
    actions = ["ecr:BatchCheckLayerAvailability", "ecr:PutImage", "ecr:InitiateLayerUpload",
    "ecr:UploadLayerPart", "ecr:CompleteLayerUpload"]
    resources = ["arn:aws:ecr:${var.aws_region}:${var.account_id}:repository/better-music-sheet"]
  }
  statement {
    sid       = "ReadAudiverisBundle"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::audiveris/*"]
  }
  statement {
    sid       = "PublishWebUi"
    actions   = ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.existing_web_bucket_name}", "arn:aws:s3:::${var.existing_web_bucket_name}/*"]
  }
  statement {
    sid       = "InvalidateCdn"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = ["*"]
  }
  # GetFunction backs `aws lambda wait function-updated`, which the workflow
  # uses to avoid racing the next deploy against an in-progress update.
  statement {
    sid     = "DeployLambdaCode"
    actions = ["lambda:UpdateFunctionCode", "lambda:GetFunction", "lambda:GetFunctionConfiguration"]
    resources = var.enable_serverless ? [
      "arn:aws:lambda:${var.aws_region}:${var.account_id}:function:${module.serverless[0].api_function}",
      "arn:aws:lambda:${var.aws_region}:${var.account_id}:function:${module.serverless[0].controller_function}",
    ] : ["arn:aws:lambda:${var.aws_region}:${var.account_id}:function:none"]
  }
  # RegisterTaskDefinition has no resource-level control; a new revision is
  # only reachable through the UpdateService grant below, which is scoped.
  statement {
    sid       = "RegisterWorkerRevision"
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
    resources = ["*"]
  }
  statement {
    sid     = "DeployWorkerService"
    actions = ["ecs:DescribeServices", "ecs:UpdateService"]
    resources = var.enable_serverless ? [
      "arn:aws:ecs:${var.aws_region}:${var.account_id}:service/${var.existing_ecs_cluster_name}/${module.serverless[0].worker_service}",
    ] : ["arn:aws:ecs:${var.aws_region}:${var.account_id}:service/${var.existing_ecs_cluster_name}/none"]
  }
  statement {
    sid     = "PassWorkerRoles"
    actions = ["iam:PassRole"]
    resources = var.enable_serverless ? [
      module.serverless[0].worker_role_arn,
      module.serverless[0].execution_role_arn,
    ] : ["arn:aws:iam::${var.account_id}:role/none"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy-permissions"
  role   = var.github_deploy_role_name
  policy = data.aws_iam_policy_document.github_deploy.json
}
