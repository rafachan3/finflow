# Phase 4.5: the scheduled nudge Lambda (daily digest). Separate from the
# ingest webhook and deliberately without a Function URL: the only caller is
# the EventBridge Scheduler role below. Real code ships via
# update-function-code, like ingest (ignore_changes).

resource "aws_cloudwatch_log_group" "nudge" {
  name              = "/aws/lambda/finflow-nudge"
  retention_in_days = 14
}

resource "aws_iam_role" "nudge" {
  name = "finflow-nudge"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "nudge_logs" {
  name = "logs"
  role = aws_iam_role.nudge.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ]
      Resource = "${aws_cloudwatch_log_group.nudge.arn}:*"
    }]
  })
}

# Exactly the three parameters the digest needs: no Gemini key, no webhook
# secret, no bucket rules, and no path wildcard.
resource "aws_iam_role_policy" "nudge_ssm" {
  name = "ssm"
  role = aws_iam_role.nudge.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["ssm:GetParameter"]
        Resource = [
          aws_ssm_parameter.telegram_bot_token.arn,
          aws_ssm_parameter.telegram_allowed_chat_ids.arn,
          aws_ssm_parameter.supabase_database_url.arn,
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.ca-central-1.amazonaws.com"
          }
        }
      },
    ]
  })
}

resource "aws_lambda_function" "nudge" {
  function_name = "finflow-nudge"
  role          = aws_iam_role.nudge.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  timeout       = 30
  memory_size   = 128

  filename         = data.archive_file.bootstrap.output_path
  source_code_hash = data.archive_file.bootstrap.output_base64sha256

  depends_on = [aws_cloudwatch_log_group.nudge]

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

# The scheduler's role may invoke the nudge function and nothing else.
resource "aws_iam_role" "scheduler" {
  name = "finflow-scheduler"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "scheduler.amazonaws.com"
      }
      Action = "sts:AssumeRole"
      Condition = {
        StringEquals = {
          "aws:SourceAccount" = data.aws_caller_identity.current.account_id
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler_invoke_nudge" {
  name = "invoke-nudge"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = aws_lambda_function.nudge.arn
    }]
  })
}

# 09:00 local time all year: the scheduler applies the IANA zone and DST
# itself, so no UTC cron needs a seasonal edit. The scheduled time goes into
# the payload so a retry keeps the original run date. Delivery is
# at-least-once; the handler's nudge_runs claim makes it idempotent.
resource "aws_scheduler_schedule" "daily_digest" {
  name                         = "finflow-daily-digest"
  schedule_expression          = "cron(0 9 * * ? *)"
  schedule_expression_timezone = "America/Toronto"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.nudge.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ scheduled_time = "<aws.scheduler.scheduled-time>" })

    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 3600
    }
  }
}
