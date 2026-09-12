output "job_files_bucket" {
  value = aws_s3_bucket.job_files.bucket
}

output "ecs_task_role_arn" {
  value = aws_iam_role.ecs_task.arn
}

output "alb_target_group_arn" {
  description = "Set this as the ECS service's load balancer target group when recreating it in Phase 1"
  value       = aws_lb_target_group.backend.arn
}

output "api_url" {
  value = "https://${var.api_subdomain}"
}

output "web_url" {
  value = "https://${var.domain_name}"
}

output "cloudfront_distribution_id" {
  description = "Needed to invalidate the CDN cache after deploying a new build (aws cloudfront create-invalidation --paths '/*')"
  value       = aws_cloudfront_distribution.web.id
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.web.domain_name
}

output "cognito_user_pool_id" {
  description = "COGNITO_USER_POOL_ID for the backend task definition"
  value       = aws_cognito_user_pool.users.id
}

output "cognito_app_client_id" {
  description = "COGNITO_APP_CLIENT_ID for the backend, and NEXT_PUBLIC_COGNITO_CLIENT_ID for the frontend build"
  value       = aws_cognito_user_pool_client.web.id
}

output "cognito_hosted_ui_domain" {
  description = "NEXT_PUBLIC_COGNITO_DOMAIN for the frontend build (no trailing slash)"
  value       = "https://${aws_cognito_user_pool_domain.users.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "backend_jwt_secret_ssm_arn" {
  description = "Set as the BACKEND_JWT_SECRET `secrets` valueFrom in the ECS task definition - never as a plaintext environment entry"
  value       = aws_ssm_parameter.backend_jwt_secret.arn
}

output "users_table" {
  value = aws_dynamodb_table.users.name
}

output "music_sheet_table" {
  value = aws_dynamodb_table.music_sheet.name
}

output "annotation_job_table" {
  value = aws_dynamodb_table.annotation_job.name
}
