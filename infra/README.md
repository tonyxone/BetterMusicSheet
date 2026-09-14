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

### Running Terraform with social-provider credentials

Google's `google_client_id` and `google_client_secret`, plus Apple's
`apple_team_id`, `apple_services_id`, `apple_key_id`, and `apple_private_key`,
are stored as key/value pairs in the `better_music_sheet_singin_provider` AWS
Secrets Manager secret.
Use the wrapper for your platform instead of invoking `terraform plan` or
`terraform apply` directly, so the values exist only as process environment
variables while Terraform runs:

```powershell
.\terraform-with-secrets.ps1 -Command plan
.\terraform-with-secrets.ps1 -Command apply
```

```bash
./terraform-with-secrets.sh plan
./terraform-with-secrets.sh apply
```

Both read the project's secret ARN by default (`-SecretArn` / `BMS_SOCIAL_SECRET_ARN`
to override) and neither saves a plan file, because Terraform plans can
contain secret values. Cognito's Terraform resource still stores these
provider details in the encrypted remote state, so access to the state
bucket must remain restricted.

## Before your first apply

- State already lives in the private S3 backend (see `backend.tf` /
  `backend.hcl`, from `state-bootstrap/`), so a Mac and a Windows machine (or
  CI - see "After every release" below) can all apply against the same
  state. `backend.hcl` is gitignored; a fresh checkout needs its own copy
  (bucket/key/region only, no secrets - see `backend.hcl.example`) before
  `terraform init`.

## After every release

This used to be entirely manual (update `serverless_api_image` /
`serverless_worker_image` in `serverless.tfvars`, then `terraform apply`).
The release workflow's `plan-infra` job now automates the first half: it
reads whatever image is actually running right now (the same
`aws lambda get-function` / `aws ecs describe-task-definition` calls
`drift.yml` uses) and runs `terraform plan` with those as `-var` overrides,
using a dedicated CI role (`infra/terraform-apply-role.tf`, assumed via
`TF_APPLY_AWS_ROLE_ARN`). The plan, plus a ready-to-run `terraform apply`
command with the correct image tags filled in, lands in that job's step
summary.

**It deliberately does not apply.** A hand-crafted least-privilege IAM
policy is exactly the kind of thing that can be missing one read-only
permission the AWS provider needs to *confirm a resource still exists* -
get that wrong and `apply` reads AccessDenied as "this was deleted outside
Terraform" and recreates it for real. That happened once already: a missing
`s3:ListBucket`/`s3:HeadBucket` grant made the v2 files bucket look gone,
and Terraform actually deleted its CORS, notification and
public-access-block configuration before recreating them - silently
breaking uploads until it was caught and fixed by hand (see the git history
on `infra/terraform-apply-role.tf` for the exact permissions that were
missing). So for now, review the plan, then run the apply yourself.

Why the image sync matters at all: the Lambda functions declare
`ignore_changes` on their image, so the release owns their code and
Terraform leaves it alone. The ECS worker cannot do the same: ECS keeps the
image, the command and every environment variable in one
`container_definitions` attribute, and `ignore_changes` works per attribute -
excluding the image would also stop Terraform managing the environment,
which is worse than the problem. So Terraform believes whatever it was last
told, and an apply run for an entirely unrelated reason would quietly revert
the worker to an older image. That happened once too (v0.0.26 → v0.0.23) -
see the comments in `modules/serverless/compute.tf`.

**This changes what `serverless.tfvars` is for.** Its two image lines are no
longer kept fresh by habit, so treat them as stale by default. Before any
apply - the CI-posted one or an unrelated local change - pull the current
tags the same way the workflow does, and pass them as `-var`:

```bash
aws lambda get-function --function-name <API_LAMBDA_FUNCTION> --query 'Code.ImageUri' --output text
aws ecs describe-task-definition --task-definition <the worker service's current one> --query 'taskDefinition.containerDefinitions[0].image' --output text
```

then e.g. `terraform apply -var-file=serverless.tfvars -var serverless_api_image=<api> -var serverless_worker_image=<worker>`,
which overrides whatever the file says.

The scheduled drift check (`.github/workflows/drift.yml`) still reports any
mismatch within a day, as a backstop - not as the plan.

## Migrating to the serverless backend

`serverless.tf` and `modules/serverless/` provision the Lambda API, SQS queue,
and scale-to-zero Fargate workers that replace the always-on ECS API and its
ALB. Both switches (`enable_serverless`, `serverless_api_cutover`) default to
off, so nothing here touches production until you set them.

The step-by-step rollout, smoke tests, alarm meanings and rollback are in
[`../docs/serverless-migration.md`](../docs/serverless-migration.md). Start
there rather than applying `serverless.tf` directly.
