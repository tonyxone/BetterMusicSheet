resource "aws_cloudwatch_log_group" "logs" {
  for_each          = toset(["api", "controller", "worker"])
  name              = "/${local.name}/${each.key}"
  retention_in_days = 14
}

resource "aws_lambda_function" "api" {
  function_name                  = "${local.name}-api"
  role                           = aws_iam_role.api.arn
  package_type                   = "Image"
  image_uri                      = var.api_image
  architectures                  = ["x86_64"]
  memory_size                    = 512
  timeout                        = 25
  reserved_concurrent_executions = 10
  environment {
    variables = merge(local.environment, { BACKEND_JWT_SECRET_PARAMETER = var.secret_parameter })
  }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.logs["api"].name
  }
  depends_on = [aws_iam_role_policy.api]
}

resource "aws_lambda_function" "controller" {
  function_name = "${local.name}-controller"
  role          = aws_iam_role.controller.arn
  package_type  = "Image"
  image_uri     = var.api_image
  image_config { command = ["controller.handler"] }
  architectures                  = ["x86_64"]
  memory_size                    = 256
  timeout                        = 55
  reserved_concurrent_executions = 1
  environment {
    variables = merge(local.environment, {
      WORKER_CLUSTER = var.cluster_name, WORKER_SERVICE = "${local.name}-worker",
      MAX_WORKERS    = tostring(var.max_workers)
    })
  }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.logs["controller"].name
  }
  depends_on = [aws_iam_role_policy.controller]
}

resource "aws_cloudwatch_event_rule" "reconcile" {
  name                = "${local.name}-reconcile"
  schedule_expression = "rate(1 minute)"
}
resource "aws_cloudwatch_event_target" "reconcile" {
  rule = aws_cloudwatch_event_rule.reconcile.name
  arn  = aws_lambda_function.controller.arn
  retry_policy { maximum_event_age_in_seconds = 60 }
}
resource "aws_lambda_permission" "reconcile" {
  statement_id  = "ScheduledReconcile"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.controller.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.reconcile.arn
}

resource "aws_security_group" "worker" {
  name   = "${local.name}-worker"
  vpc_id = var.vpc_id
  # Outbound-only tasks; there is no web server listening or inbound rule.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "2048"
  memory                   = "4096"
  task_role_arn            = aws_iam_role.worker.arn
  execution_role_arn       = aws_iam_role.execution.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name        = "worker", image = var.worker_image, essential = true,
    command     = ["python3", "worker.py"], stopTimeout = 120,
    environment = [for k, v in local.environment : { name = k, value = v }],
    logConfiguration = { logDriver = "awslogs", options = {
      "awslogs-group"  = aws_cloudwatch_log_group.logs["worker"].name,
      "awslogs-region" = var.region, "awslogs-stream-prefix" = "worker"
    } }
  }])
}

resource "aws_ecs_service" "worker" {
  name                               = "${local.name}-worker"
  cluster                            = data.aws_ecs_cluster.existing.arn
  task_definition                    = aws_ecs_task_definition.worker.arn
  desired_count                      = 0
  platform_version                   = "1.4.0"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    base              = var.spot_burst ? 1 : 0
    weight            = var.spot_burst ? 0 : 1
  }
  dynamic "capacity_provider_strategy" {
    for_each = var.spot_burst ? [1] : []
    content {
      capacity_provider = "FARGATE_SPOT"
      weight            = 1
    }
  }
  network_configuration {
    subnets          = var.subnets
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = true
  }
  lifecycle { ignore_changes = [desired_count] }
  depends_on = [aws_iam_role_policy.worker, aws_iam_role_policy.execution]
}

resource "aws_apigatewayv2_api" "api" {
  name          = "${local.name}-api"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = var.origins
    allow_methods = ["GET", "POST", "DELETE", "OPTIONS"]
    allow_headers = ["authorization", "content-type", "x-guest-id"]
    max_age       = 300
  }
}
resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}
resource "aws_apigatewayv2_route" "api" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "ANY /api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}
resource "aws_apigatewayv2_stage" "api" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 20
  }
}
resource "aws_lambda_permission" "api" {
  statement_id  = "ApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*/api/*"
}
resource "aws_apigatewayv2_domain_name" "api" {
  domain_name = var.api_domain
  domain_name_configuration {
    certificate_arn = var.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}
resource "aws_apigatewayv2_api_mapping" "api" {
  api_id      = aws_apigatewayv2_api.api.id
  domain_name = aws_apigatewayv2_domain_name.api.id
  stage       = aws_apigatewayv2_stage.api.id
}

output "api_url" { value = aws_apigatewayv2_api.api.api_endpoint }
output "api_function" { value = aws_lambda_function.api.function_name }
output "controller_function" { value = aws_lambda_function.controller.function_name }
output "worker_service" { value = aws_ecs_service.worker.name }
output "domain_target" { value = aws_apigatewayv2_domain_name.api.domain_name_configuration[0].target_domain_name }
output "domain_zone" { value = aws_apigatewayv2_domain_name.api.domain_name_configuration[0].hosted_zone_id }
