# Infrastructure (Terraform)

Provisions the AWS resources this app actually needs: a private S3 bucket for
job files, an IAM task role, an ALB + regional ACM cert for
`api.bettermusicsheet.com`, a Cognito user pool for sign-in, three DynamoDB
tables for job/user state, and the SSM parameter holding the backend's JWT
signing secret.

Sign-in is **optional** in the app - a signed-out visitor uploads under an
anonymous per-browser guest id (see `../auth.py`), and only someone who
actually signs in gets a `users` row. The Cognito resources are therefore
not on the critical path for uploading; the DynamoDB tables are, since all
job state lives there in production (see `../db.py`).

The app client is a **public** client with no secret (`generate_secret =
false`): the frontend is a static export with no server of its own, so it
uses authorization-code + PKCE. Don't "fix" that by generating a secret -
the browser flow cannot complete with one.

An earlier revision of this config dropped Cognito/DynamoDB entirely and a
later one restored them. If you're applying on top of that stripped-down
state, this apply **creates** the pool and tables fresh - any rows or users
from before that removal are gone and are not recovered by re-applying.

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

3. **After apply**, two things still need doing by hand:
   - The existing ECS service (`music-sheet-annotator-svc`) can't have a load
     balancer attached after the fact — ECS only supports setting that at
     service creation. Recreate the service with `--load-balancers` pointing
     at `alb_target_group_arn` (from `terraform output`) **and** the new
     `ecs_task_role_arn` set as the task definition's `taskRoleArn` (see
     `../taskdef-new.json`, which also sets `APP_ENV=production`).
   - Tighten the ECS task's security group (`sg-0c5bee1ed4ec7017f` today) to
     allow port 8000 only from the new ALB security group
     (`aws_security_group.alb`, see `terraform output` or the AWS console),
     instead of directly from the internet. Not Terraform-managed here since
     it means editing an existing, unmanaged security group rather than
     creating a new resource.

4. `terraform output` afterward gives everything needed: `job_files_bucket`,
   `ecs_task_role_arn`, `alb_target_group_arn`, `api_url`, plus the auth
   values below.

## Wiring up sign-in after an apply

`terraform output` produces the values both halves of the app need. Neither
is picked up automatically - the backend reads env vars from the task
definition, and the frontend inlines its at build time.

**Backend** (`../taskdef-new.json`, then register a new revision): set
`COGNITO_USER_POOL_ID` and `COGNITO_APP_CLIENT_ID` from
`cognito_user_pool_id` / `cognito_app_client_id`. `USERS_TABLE`,
`MUSIC_SHEET_TABLE` and `ANNOTATION_JOB_TABLE` are already filled in with
the names this config creates. `BACKEND_JWT_SECRET` is deliberately a
`secrets` entry rather than an `environment` one, so the plaintext never
appears in the task definition - its `valueFrom` is
`backend_jwt_secret_ssm_arn`.

**Frontend** (GitHub repo *variables*, read by `.github/workflows/release.yml`):
set `COGNITO_DOMAIN` to `cognito_hosted_ui_domain` and
`COGNITO_APP_CLIENT_ID` to `cognito_app_client_id`. These are public
identifiers that end up in the shipped JS bundle - variables, not secrets.
Leave them unset and the app still deploys and works; the Sign in button
just doesn't render.

Callback URLs are registered in `cognito.tf` for the apex domain, `www`, and
`http://localhost:3000` - all with a **trailing slash**, which Cognito
matches exactly and which is what `trailingSlash` in
`../better_music_sheet_web/next.config.ts` actually produces.

## Before your first apply

- State is local (`terraform.tfstate` in this directory, gitignored). Fine
  for one person on one machine; move to an S3 backend (commented out in
  `versions.tf`) before more than one person/machine touches this.
