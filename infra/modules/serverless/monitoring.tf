resource "aws_sns_topic" "alerts" { name = "${local.name}-alerts" }

# An alarm with no subscriber is silent. Confirm the emailed subscription once;
# until it is confirmed, AWS holds the subscription "pending" and drops alerts.
resource "aws_sns_topic_subscription" "alerts" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${local.name}-queue-age"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.jobs.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_metric_alarm" "dlq" {
  alarm_name          = "${local.name}-dlq"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.failed.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each            = { api = aws_lambda_function.api.function_name, controller = aws_lambda_function.controller.function_name }
  alarm_name          = "${local.name}-${each.key}-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# The controller prints its scaling decision every minute; reading the cap back
# out of that log is cheaper than Container Insights and needs no extra call.
resource "aws_cloudwatch_log_metric_filter" "desired_workers" {
  name           = "${local.name}-desired-workers"
  log_group_name = aws_cloudwatch_log_group.logs["controller"].name
  pattern        = "{ $.desired = * }"
  metric_transformation {
    name      = "DesiredWorkers"
    namespace = local.name
    value     = "$.desired"
    unit      = "Count"
  }
}
resource "aws_cloudwatch_metric_alarm" "worker_cap" {
  alarm_name  = "${local.name}-worker-cap"
  namespace   = local.name
  metric_name = aws_cloudwatch_log_metric_filter.desired_workers.metric_transformation[0].name
  statistic   = "Maximum"
  period      = 300
  # Two periods, so a brief burst to the cap is not an alert; ten minutes
  # pinned at the cap means the backlog is outrunning the worker budget.
  evaluation_periods  = 2
  threshold           = var.max_workers
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

output "alerts_topic" { value = aws_sns_topic.alerts.arn }
