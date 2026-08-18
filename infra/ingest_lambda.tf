# Phase 2: ingest Lambda stub, Function URL, and SSM parameter shells.
# Real function code ships via update-function-code (OIDC deploy role);
# Terraform never owns the zip after the first apply (ignore_changes).

resource "aws_cloudwatch_log_group" "ingest" {
  name              = "/aws/lambda/finflow-ingest"
  retention_in_days = 14
}

resource "aws_iam_role" "ingest" {
  name = "finflow-ingest"

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

resource "aws_iam_role_policy" "ingest_logs" {
  name = "logs"
  role = aws_iam_role.ingest.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ]
      Resource = "${aws_cloudwatch_log_group.ingest.arn}:*"
    }]
  })
}

resource "aws_iam_role_policy" "ingest_ssm" {
  name = "ssm"
  role = aws_iam_role.ingest.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:ca-central-1:*:parameter/finflow/*"
      },
      {
        # Default aws/ssm CMK (no project CMK yet). Scope via ViaService so
        # decrypt is only allowed for SSM Parameter Store in this region.
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

data "archive_file" "bootstrap" {
  type        = "zip"
  output_path = "${path.module}/.terraform/bootstrap.zip"

  source {
    content  = "exports.handler = async () => ({ statusCode: 200, body: 'bootstrap' });\n"
    filename = "index.js"
  }
}

resource "aws_lambda_function" "ingest" {
  function_name = "finflow-ingest"
  role          = aws_iam_role.ingest.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  timeout       = 30

  filename         = data.archive_file.bootstrap.output_path
  source_code_hash = data.archive_file.bootstrap.output_base64sha256

  depends_on = [aws_cloudwatch_log_group.ingest]

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

resource "aws_lambda_function_url" "ingest" {
  function_name      = aws_lambda_function.ingest.function_name
  authorization_type = "NONE"
}

resource "aws_ssm_parameter" "telegram_bot_token" {
  name  = "/finflow/telegram/bot-token"
  type  = "SecureString"
  value = "REPLACE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "telegram_webhook_secret" {
  name  = "/finflow/telegram/webhook-secret"
  type  = "SecureString"
  value = "REPLACE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "telegram_allowed_chat_ids" {
  name  = "/finflow/telegram/allowed-chat-ids"
  type  = "SecureString"
  value = "REPLACE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "supabase_database_url" {
  name  = "/finflow/supabase/database-url"
  type  = "SecureString"
  value = "REPLACE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "gemini_api_key" {
  name  = "/finflow/gemini/api-key"
  type  = "SecureString"
  value = "REPLACE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}

# Advanced: BUCKET_RULES.local.md is ~6KB; standard SSM max is 4KB.
resource "aws_ssm_parameter" "bucket_rules" {
  name  = "/finflow/bucket-rules"
  type  = "SecureString"
  tier  = "Advanced"
  value = "REPLACE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}
