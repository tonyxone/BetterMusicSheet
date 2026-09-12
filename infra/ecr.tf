# Nothing ever deleted a container image, so the repository had grown to 34
# images and 8.75 GB - more than half the stack's fixed monthly cost, and rising
# by about $0.05/month with every release, permanently. The repository itself
# was created by hand and stays unmanaged (see README); only its lifecycle
# policy is declared here.
#
# Rules are evaluated in priority order and the FIRST match wins, so the
# expiries by age come before the keep-the-last-N counts.
variable "existing_ecr_repository_name" {
  description = "ECR repository the release workflow pushes to - created by hand, not managed here"
  type        = string
  default     = "better-music-sheet"
}

resource "aws_ecr_lifecycle_policy" "images" {
  repository = var.existing_ecr_repository_name

  policy = jsonencode({
    rules = [
      {
        # Retagging `latest` orphans the image it pointed at. Nothing can pull
        # an untagged image, so it is pure storage cost.
        rulePriority = 1
        description  = "Expire untagged images after a day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        # Scratch builds pushed by hand while working on a change. They are
        # never a rollback target once a release supersedes them.
        rulePriority = 2
        description  = "Expire hand-built migration images after a week"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["migration-", "api-migration-"]
          countType     = "sinceImagePushed"
          countUnit     = "days"
          countNumber   = 7
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 3
        description  = "Keep the last 5 API images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["api-v"]
          countType     = "imageCountMoreThan"
          countNumber   = 5
        }
        action = { type = "expire" }
      },
      {
        # `v` does not match `api-v`, so the two release streams are counted
        # separately and five of each survive.
        rulePriority = 4
        description  = "Keep the last 5 worker images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["v"]
          countType     = "imageCountMoreThan"
          countNumber   = 5
        }
        action = { type = "expire" }
      },
    ]
  })
}
