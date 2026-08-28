# Infrastructure (Terraform) — Phase 0

Provisions the new AWS resources for the auth/database/custom-domain phase
(see `../.claude` plan history, or ask for a recap): Cognito, two DynamoDB
tables, a private S3 bucket for job files, a new IAM task role, and an ALB +
regional ACM cert for `api.bettermusicsheet.com`.

**Deliberately out of scope here** — existing resources created by hand
earlier this project (ECR repo, the current ECS cluster/service, the public
`better-music-sheet-web` S3 bucket, the GitHub OIDC IAM role) are left alone,
not imported into this state, so this apply can't disturb what's already
running.

## Required order

1. **Register `bettermusicsheet.com` manually first.** Terraform cannot
   purchase a new domain (`aws_route53domains_registered_domain` only manages
   settings on an *already*-registered domain — registration itself needs
   contact/payment info and ICANN term acceptance, not a clean Terraform fit).
   Console: Route 53 → Registered domains → Register domain. This is a real
   purchase (~$12–15/yr) and has unpredictable propagation delay — do it
   first and let it finish before anything below.

2. `terraform init`, then `terraform plan` / `terraform apply` from this
   directory. `route53.tf` and `acm.tf` will fail to apply until step 1's
   domain registration has actually completed (they look up the
   auto-created hosted zone by name) — that's expected, not a bug.

3. **After apply**, two things still need doing by hand (Phase 1, alongside
   the `server.py` changes, not part of this apply):
   - The existing ECS service (`music-sheet-annotator-svc`) can't have a load
     balancer attached after the fact — ECS only supports setting that at
     service creation. Recreate the service with `--load-balancers` pointing
     at `alb_target_group_arn` (from `terraform output`) **and** the new
     `ecs_task_role_arn` set as the task definition's `taskRoleArn`, at the
     same time as deploying the Phase-1 `server.py` changes that actually use
     that role's DynamoDB/S3 permissions.
   - Tighten the ECS task's security group (`sg-0c5bee1ed4ec7017f` today) to
     allow port 8000 only from the new ALB security group
     (`aws_security_group.alb`, see `terraform output` or the AWS console),
     instead of directly from the internet. Not Terraform-managed here since
     it means editing an existing, unmanaged security group rather than
     creating a new resource.

4. `terraform output` afterward gives everything needed for Phase 1/2 env
   vars: `cognito_app_client_id`, `cognito_app_client_secret` (sensitive —
   `terraform output -raw cognito_app_client_secret`), `cognito_issuer_url`,
   `dynamodb_users_table`, `dynamodb_music_sheet_table`, `dynamodb_annotation_job_table`, `job_files_bucket`,
   `ecs_task_role_arn`, `alb_target_group_arn`, `api_url`.

## Before your first apply

- `cognito.tf`'s `callback_urls`/`logout_urls` have a `<amplify-branch>`
  placeholder — fill in the real Amplify default domain once that app exists
  (Phase 2), or apply once now with just the real-domain URL and re-apply
  after Amplify is up.
- State is local (`terraform.tfstate` in this directory, gitignored — it
  contains the Cognito client secret in plaintext). Fine for one person on
  one machine; move to an S3 backend (commented out in `versions.tf`) before
  more than one person/machine touches this.
