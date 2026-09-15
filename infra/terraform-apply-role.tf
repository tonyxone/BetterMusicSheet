# CI identity for running `terraform apply` from the release workflow, so the
# post-release image-tag sync (see infra/README.md) stops depending on a
# human running Terraform locally. Bootstrapped the same way github_drift is
# in deploy-role.tf: trust policy borrowed from the existing hand-created
# deploy role, so it reuses the same GitHub OIDC subject claim rather than a
# second trust relationship to hand-configure.
#
# PowerUserAccess, not a hand-enumerated list of actions. An earlier version
# of this file tried to name every action Terraform needs, scoped down as
# tightly as possible - and a real CI run proved that approach dangerous, not
# just tedious: the AWS provider makes a long list of read-only calls during
# refresh that aren't obvious from reading infra/*.tf (bucket existence
# checks, MFA config, log-group lookups, task-definition version lookups...),
# and missing even one on a resource whose existence-check silently maps
# AccessDenied to "not found" makes Terraform decide that resource was
# deleted outside Terraform - and it really did delete and recreate the v2
# files bucket's CORS/notification/public-access-block config once, before
# the gap was found. Five rounds of "found one more missing read permission"
# for S3 ALONE proved this doesn't scale. PowerUserAccess covers virtually
# every read/write call across every service (excluding IAM and
# Organizations), which makes that whole failure mode structurally
# impossible - not "we found every gap," but "there is no gap of that shape
# left to find."
#
# What PowerUserAccess deliberately excludes is IAM management, so this role
# still needs its own narrow inline policy for that: creating/updating the
# serverless module's four roles, passing them to Lambda/ECS, and managing
# its own (and its sibling CI roles') inline policies, since deploy-role.tf
# declares all of that as Terraform resources too.
#
# Bootstrapping note: this role cannot grant itself into existence over
# OIDC. The first apply that creates it has to run locally, the same way
# github_drift originally did.

resource "aws_iam_role" "github_terraform_apply" {
  name               = "${var.project}-github-terraform-apply"
  description        = "Runs terraform apply from the release workflow"
  assume_role_policy = data.aws_iam_role.github_deploy.assume_role_policy
}

resource "aws_iam_role_policy_attachment" "github_terraform_apply" {
  role       = aws_iam_role.github_terraform_apply.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

data "aws_iam_policy_document" "github_terraform_apply_iam" {
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
}

resource "aws_iam_role_policy" "github_terraform_apply_iam" {
  name   = "terraform-apply-iam"
  role   = aws_iam_role.github_terraform_apply.name
  policy = data.aws_iam_policy_document.github_terraform_apply_iam.json
}

output "github_terraform_apply_role_arn" {
  description = "Set as the TF_APPLY_AWS_ROLE_ARN repo variable"
  value       = aws_iam_role.github_terraform_apply.arn
}
