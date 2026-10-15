# What a release of the Audiveris fork (tonyxone/audiveris) may do: put its
# build at the top of the audiveris bucket and move the one it replaces into
# archive/. The release workflow here (release.yml) ships whichever single
# build sits at the top, so this is how a fork release reaches the next
# BetterMusicSheet release - and all it can reach: it can't deploy anything.
#
# Trusted only for the fork's tags (a published release) and its master
# (a manual run of the same workflow), through the GitHub OIDC provider the
# deploy role already uses. Named, not looked up: the CI role that applies
# this (terraform-apply-role.tf) may not read IAM beyond its sibling roles.

data "aws_iam_policy_document" "audiveris_publish_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = ["arn:aws:iam::${var.account_id}:oidc-provider/token.actions.githubusercontent.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      # GitHub's immutable subjects, with owner and repository ids
      # (gh api repos/tonyxone/audiveris/actions/oidc/customization/sub).
      values = [
        "repo:tonyxone@9955097/audiveris@1414820849:ref:refs/tags/*",
        "repo:tonyxone@9955097/audiveris@1414820849:ref:refs/heads/master",
      ]
    }
  }
}

resource "aws_iam_role" "audiveris_publish" {
  name               = "${var.project}-audiveris-publish"
  description        = "Uploads an Audiveris fork release to the audiveris bucket"
  assume_role_policy = data.aws_iam_policy_document.audiveris_publish_trust.json
}

data "aws_iam_policy_document" "audiveris_publish" {
  statement {
    sid       = "ListBuilds"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::audiveris"]
  }
  # Moving a build into archive/ is a copy and a delete.
  statement {
    sid       = "PublishAndArchiveBuilds"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::audiveris/*"]
  }
}

resource "aws_iam_role_policy" "audiveris_publish" {
  name   = "publish-builds"
  role   = aws_iam_role.audiveris_publish.name
  policy = data.aws_iam_policy_document.audiveris_publish.json
}

output "audiveris_publish_role_arn" {
  description = "Set as the AWS_ROLE_ARN variable of tonyxone/audiveris"
  value       = aws_iam_role.audiveris_publish.arn
}
