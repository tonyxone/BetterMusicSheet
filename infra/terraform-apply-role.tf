# CI identity for running `terraform apply` from the release workflow, so the
# post-release image-tag sync (see infra/README.md) stops depending on a
# human running Terraform locally. Bootstrapped the same way github_drift is
# in deploy-role.tf: trust policy borrowed from the existing hand-created
# deploy role, so it reuses the same GitHub OIDC subject claim rather than a
# second trust relationship to hand-configure.
#
# This is the one role in this config with write access across nearly every
# service the stack uses - narrower than PowerUserAccess, but still broad by
# necessity, because that is what applying infra/*.tf actually requires.
# Every statement below maps to a resource type actually declared under
# infra/ or infra/modules/serverless/ - nothing speculative.
#
# Bootstrapping note: this role cannot grant itself into existence over
# OIDC. The first apply that creates it has to run locally, the same way
# github_drift originally did.

variable "tf_state_bucket_name" {
  description = "Terraform state bucket - must match infra/backend.hcl"
  type        = string
  default     = "bettermusicsheet-tfstate-324752064997"
}

data "aws_iam_policy_document" "github_terraform_apply" {
  statement { # Terraform state + lock (S3-native locking, use_lockfile = true)
    sid       = "TerraformState"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.tf_state_bucket_name}", "arn:aws:s3:::${var.tf_state_bucket_name}/*"]
  }

  statement { # acm.tf
    sid       = "Acm"
    actions   = ["acm:RequestCertificate", "acm:DescribeCertificate", "acm:DeleteCertificate", "acm:AddTagsToCertificate", "acm:RemoveTagsFromCertificate", "acm:ListTagsForCertificate"]
    resources = ["arn:aws:acm:*:${var.account_id}:certificate/*"]
  }

  statement { # route53.tf, and the cert validation records in acm.tf
    sid       = "Route53"
    actions   = ["route53:ChangeResourceRecordSets", "route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ListTagsForResource"]
    resources = ["arn:aws:route53:::hostedzone/*"]
  }
  statement { # these three don't support resource-level scoping
    sid       = "Route53Account"
    actions   = ["route53:ListHostedZones", "route53:ListHostedZonesByName", "route53:GetChange"]
    resources = ["*"]
  }

  statement { # cloudfront.tf
    sid       = "CloudFront"
    actions   = ["cloudfront:CreateDistribution", "cloudfront:GetDistribution", "cloudfront:UpdateDistribution", "cloudfront:DeleteDistribution", "cloudfront:TagResource", "cloudfront:UntagResource", "cloudfront:ListTagsForResource"]
    resources = ["arn:aws:cloudfront::${var.account_id}:distribution/*"]
  }
  statement {
    sid       = "CloudFrontAccount"
    actions   = ["cloudfront:ListDistributions"]
    resources = ["*"]
  }

  statement { # cognito.tf, cognito-idp.tf
    sid = "Cognito"
    actions = [
      "cognito-idp:CreateUserPool", "cognito-idp:DescribeUserPool", "cognito-idp:UpdateUserPool", "cognito-idp:DeleteUserPool",
      "cognito-idp:TagResource", "cognito-idp:UntagResource",
      "cognito-idp:CreateUserPoolClient", "cognito-idp:DescribeUserPoolClient", "cognito-idp:UpdateUserPoolClient", "cognito-idp:DeleteUserPoolClient", "cognito-idp:ListUserPoolClients",
      "cognito-idp:CreateUserPoolDomain", "cognito-idp:DescribeUserPoolDomain", "cognito-idp:DeleteUserPoolDomain", "cognito-idp:UpdateUserPoolDomain",
      "cognito-idp:SetUICustomization", "cognito-idp:GetUICustomization",
      "cognito-idp:CreateIdentityProvider", "cognito-idp:DescribeIdentityProvider", "cognito-idp:UpdateIdentityProvider", "cognito-idp:DeleteIdentityProvider", "cognito-idp:ListIdentityProviders",
      # Read on every refresh of aws_cognito_user_pool even though this config
      # never touches MFA - the provider always asks. Found by an actual
      # AccessDenied in the first real CI apply, not anticipated up front.
      "cognito-idp:GetUserPoolMfaConfig",
    ]
    resources = ["arn:aws:cognito-idp:${var.aws_region}:${var.account_id}:userpool/*"]
  }
  statement { # ListUserPools takes no ARN; DescribeUserPoolDomain is keyed by
    # domain name, not the pool's ARN, so AWS won't scope it either
    # (confirmed by an actual AccessDenied)
    sid       = "CognitoAccount"
    actions   = ["cognito-idp:ListUserPools", "cognito-idp:DescribeUserPoolDomain"]
    resources = ["*"]
  }

  statement { # dynamodb.tf, plus the module's control table (storage.tf)
    sid       = "DynamoDb"
    actions   = ["dynamodb:CreateTable", "dynamodb:DescribeTable", "dynamodb:UpdateTable", "dynamodb:DeleteTable", "dynamodb:TagResource", "dynamodb:UntagResource", "dynamodb:ListTagsOfResource", "dynamodb:DescribeContinuousBackups", "dynamodb:UpdateContinuousBackups", "dynamodb:DescribeTimeToLive"]
    resources = ["arn:aws:dynamodb:${var.aws_region}:${var.account_id}:table/better-music-sheet-*"]
  }
  statement {
    sid       = "DynamoDbAccount"
    actions   = ["dynamodb:ListTables"]
    resources = ["*"]
  }

  statement { # modules/serverless/compute.tf (api, controller functions)
    sid       = "Lambda"
    actions   = ["lambda:CreateFunction", "lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:UpdateFunctionConfiguration", "lambda:UpdateFunctionCode", "lambda:DeleteFunction", "lambda:TagResource", "lambda:UntagResource", "lambda:ListTags", "lambda:AddPermission", "lambda:RemovePermission", "lambda:GetPolicy", "lambda:ListVersionsByFunction"]
    resources = ["arn:aws:lambda:${var.aws_region}:${var.account_id}:function:better-music-sheet-v2-*"]
  }

  statement { # modules/serverless/compute.tf reconcile schedule
    sid       = "EventBridge"
    actions   = ["events:PutRule", "events:DescribeRule", "events:PutTargets", "events:RemoveTargets", "events:DeleteRule", "events:ListTargetsByRule", "events:ListTagsForResource", "events:TagResource", "events:UntagResource"]
    resources = ["arn:aws:events:${var.aws_region}:${var.account_id}:rule/better-music-sheet-v2-*"]
  }

  statement { # log groups declared in modules/serverless/compute.tf, filter in monitoring.tf
    sid       = "Logs"
    actions   = ["logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:PutRetentionPolicy", "logs:ListTagsForResource", "logs:TagResource", "logs:UntagResource", "logs:PutMetricFilter", "logs:DescribeMetricFilters", "logs:DeleteMetricFilter"]
    resources = ["arn:aws:logs:${var.aws_region}:${var.account_id}:log-group:/better-music-sheet-v2/*"]
  }
  statement { # DescribeLogGroups only supports the log-group::log-stream: ARN
    # shape (confirmed by an actual AccessDenied), not a name-prefixed one
    sid       = "LogsAccount"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  statement { # modules/serverless/monitoring.tf
    sid       = "Alarms"
    actions   = ["cloudwatch:PutMetricAlarm", "cloudwatch:DescribeAlarms", "cloudwatch:DeleteAlarms", "cloudwatch:ListTagsForResource", "cloudwatch:TagResource", "cloudwatch:UntagResource"]
    resources = ["arn:aws:cloudwatch:${var.aws_region}:${var.account_id}:alarm:better-music-sheet-v2-*"]
  }

  statement {
    sid       = "Sns"
    actions   = ["sns:CreateTopic", "sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:DeleteTopic", "sns:Subscribe", "sns:Unsubscribe", "sns:GetSubscriptionAttributes", "sns:ListSubscriptionsByTopic", "sns:TagResource", "sns:UntagResource", "sns:ListTagsForResource"]
    resources = ["arn:aws:sns:${var.aws_region}:${var.account_id}:better-music-sheet-v2-alerts"]
  }

  statement { # modules/serverless/storage.tf (jobs + failed queues)
    sid       = "Sqs"
    actions   = ["sqs:CreateQueue", "sqs:GetQueueAttributes", "sqs:SetQueueAttributes", "sqs:DeleteQueue", "sqs:GetQueueUrl", "sqs:TagQueue", "sqs:UntagQueue", "sqs:ListQueueTags"]
    resources = ["arn:aws:sqs:${var.aws_region}:${var.account_id}:better-music-sheet-v2-*"]
  }
  statement {
    sid       = "SqsAccount"
    actions   = ["sqs:ListQueues"]
    resources = ["*"]
  }

  statement { # modules/serverless/compute.tf worker task definition - ECS does
    # not support resource-level scoping on these two actions
    sid       = "EcsTaskDefinitions"
    actions   = ["ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition", "ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }
  statement {
    sid       = "EcsService"
    actions   = ["ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService", "ecs:DescribeServices", "ecs:TagResource", "ecs:UntagResource", "ecs:ListTagsForResource"]
    resources = ["arn:aws:ecs:${var.aws_region}:${var.account_id}:service/${var.existing_ecs_cluster_name}/better-music-sheet-v2-worker"]
  }
  statement {
    sid       = "EcsClusterRead"
    actions   = ["ecs:DescribeClusters"]
    resources = ["arn:aws:ecs:${var.aws_region}:${var.account_id}:cluster/${var.existing_ecs_cluster_name}"]
  }

  statement { # modules/serverless/compute.tf worker security group - EC2
    # doesn't support name-prefix scoping for these
    sid       = "Ec2SecurityGroup"
    actions   = ["ec2:CreateSecurityGroup", "ec2:DescribeSecurityGroups", "ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupEgress", "ec2:CreateTags", "ec2:DescribeTags"]
    resources = ["*"]
  }

  statement { # modules/serverless/compute.tf API Gateway v2 - API Gateway's IAM
    # model is HTTP-verb actions against management-API resource paths, not
    # per-resource-type actions
    sid       = "ApiGatewayV2"
    actions   = ["apigateway:GET", "apigateway:POST", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE"]
    resources = ["arn:aws:apigateway:${var.aws_region}::/apis/*", "arn:aws:apigateway:${var.aws_region}::/domainnames/*"]
  }

  statement { # modules/serverless/iam.tf (api, controller, worker, execution roles)
    sid       = "ServerlessIamRoles"
    actions   = ["iam:CreateRole", "iam:GetRole", "iam:DeleteRole", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:TagRole", "iam:UntagRole", "iam:ListRoleTags"]
    resources = ["arn:aws:iam::${var.account_id}:role/better-music-sheet-v2-*"]
  }
  statement { # so lambda:CreateFunction / ecs:RegisterTaskDefinition can hand those roles off
    sid       = "PassServerlessRoles"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${var.account_id}:role/better-music-sheet-v2-*"]
  }

  # deploy-role.tf manages the existing hand-created deploy role's inline
  # policy, plus its own role and this one - so this role has to be able to
  # edit all three, including itself. There is no clean way to let Terraform
  # manage IAM for its own CI identity without that; the one real mitigation
  # is that nobody but the repo owner can get a change into master.
  statement {
    sid     = "SelfAndSiblingCiRoles"
    actions = ["iam:GetRole", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:ListRolePolicies", "iam:CreateRole", "iam:DeleteRole", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:ListAttachedRolePolicies", "iam:TagRole", "iam:UntagRole"]
    resources = [
      "arn:aws:iam::${var.account_id}:role/${var.github_deploy_role_name}",
      "arn:aws:iam::${var.account_id}:role/${var.project}-github-drift",
      "arn:aws:iam::${var.account_id}:role/${var.project}-github-terraform-apply",
    ]
  }

  statement { # secrets.tf
    sid       = "BackendJwtParameter"
    actions   = ["ssm:PutParameter", "ssm:GetParameter", "ssm:GetParameters", "ssm:DeleteParameter", "ssm:AddTagsToResource", "ssm:ListTagsForResource", "ssm:RemoveTagsFromResource"]
    resources = ["arn:aws:ssm:${var.aws_region}:${var.account_id}:parameter/${var.project}/*"]
  }
  statement { # DescribeParameters is read on every refresh of the parameter -
    # AWS scopes it to this account/region wildcard, not a name-prefixed ARN
    # (confirmed by an actual AccessDenied)
    sid       = "SsmDescribeParameters"
    actions   = ["ssm:DescribeParameters"]
    resources = ["arn:aws:ssm:${var.aws_region}:${var.account_id}:*"]
  }

  statement { # so the release workflow can load Google/Apple/Facebook creds
    # via infra/social-signin-env.sh before applying
    sid       = "SocialSignInSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:aws:secretsmanager:${var.aws_region}:${var.account_id}:secret:better_music_sheet_singin_provider-*"]
  }

  statement { # ecr.tf lifecycle policy on the existing, unmanaged repo
    sid       = "EcrLifecyclePolicy"
    actions   = ["ecr:PutLifecyclePolicy", "ecr:GetLifecyclePolicy", "ecr:DeleteLifecyclePolicy"]
    resources = ["arn:aws:ecr:${var.aws_region}:${var.account_id}:repository/${var.existing_ecr_repository_name}"]
  }

  statement { # modules/serverless/storage.tf v2 files bucket (full management)
    sid       = "ServerlessFilesBucket"
    actions   = ["s3:CreateBucket", "s3:DeleteBucket", "s3:PutBucketVersioning", "s3:GetBucketVersioning", "s3:PutEncryptionConfiguration", "s3:GetEncryptionConfiguration", "s3:PutBucketPublicAccessBlock", "s3:GetBucketPublicAccessBlock", "s3:PutBucketCORS", "s3:GetBucketCORS", "s3:PutLifecycleConfiguration", "s3:GetLifecycleConfiguration", "s3:PutBucketNotification", "s3:GetBucketNotification", "s3:PutBucketTagging", "s3:GetBucketTagging", "s3:GetBucketLocation", "s3:GetBucketAcl", "s3:PutBucketAcl"]
    resources = ["arn:aws:s3:::better-music-sheet-v2-files-${var.account_id}"]
  }
  statement { # modules/serverless/storage.tf CORS added to the pre-existing legacy bucket only
    sid       = "LegacyBucketCors"
    actions   = ["s3:GetBucketCORS", "s3:PutBucketCORS", "s3:GetBucketLocation"]
    resources = ["arn:aws:s3:::annotated-music-sheet"]
  }

  statement { # serverless.tf budget - only actually created once budget_email is set
    sid       = "Budget"
    actions   = ["budgets:ViewBudget", "budgets:ModifyBudget"]
    resources = ["arn:aws:budgets::${var.account_id}:budget/${var.project}-monthly"]
  }

  statement {
    sid       = "CallerIdentity"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }
}

resource "aws_iam_role" "github_terraform_apply" {
  name               = "${var.project}-github-terraform-apply"
  description        = "Runs terraform apply from the release workflow"
  assume_role_policy = data.aws_iam_role.github_deploy.assume_role_policy
}

resource "aws_iam_role_policy" "github_terraform_apply" {
  name   = "terraform-apply"
  role   = aws_iam_role.github_terraform_apply.name
  policy = data.aws_iam_policy_document.github_terraform_apply.json
}

output "github_terraform_apply_role_arn" {
  description = "Set as the TF_APPLY_AWS_ROLE_ARN repo variable"
  value       = aws_iam_role.github_terraform_apply.arn
}
