# GitHub Actions OIDC → least-privilege role that may only update ingest
# function code. No long-lived AWS keys in CI (public repo).

# Thumbprints are ignored by AWS for token.actions.githubusercontent.com
# (trusted-root library), but the API historically required a list. Keep
# the well-known DigiCert + legacy intermediate SHA-1 fingerprints.
resource "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"

  client_id_list = [
    "sts.amazonaws.com",
  ]

  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

locals {
  github_owner = split("/", var.github_repository)[0]
  github_name  = split("/", var.github_repository)[1]
  # Legacy name-only sub (pre-2026-07-15 repos) plus immutable-id sub (newer repos).
  github_oidc_subs = [
    "repo:${var.github_repository}:ref:refs/heads/main",
    "repo:${local.github_owner}@${var.github_owner_id}/${local.github_name}@${var.github_repo_id}:ref:refs/heads/main",
  ]
}

resource "aws_iam_role" "ingest_deploy" {
  name = "finflow-ingest-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.github.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = local.github_oidc_subs
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "ingest_deploy" {
  name = "update-function-code"
  role = aws_iam_role.ingest_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:UpdateFunctionCode", "lambda:GetFunctionUrlConfig", "lambda:GetFunctionConfiguration"]
      Resource = [aws_lambda_function.ingest.arn, aws_lambda_function.nudge.arn]
    }]
  })
}

# The deploy workflow registers the Telegram command menu after each deploy,
# so it reads the bot token. Exactly one parameter, never a path wildcard.
data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}

resource "aws_iam_role_policy" "ingest_deploy_bot_token" {
  name = "read-bot-token"
  role = aws_iam_role.ingest_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = aws_ssm_parameter.telegram_bot_token.arn
      },
      {
        # The parameter uses the default aws/ssm key. Scoped to that key and
        # to use through Parameter Store only.
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = data.aws_kms_alias.ssm.target_key_arn
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.ca-central-1.amazonaws.com"
          }
        }
      },
    ]
  })
}
