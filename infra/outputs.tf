output "ingest_function_url" {
  value = aws_lambda_function_url.ingest.function_url
}

output "ingest_function_name" {
  value = aws_lambda_function.ingest.function_name
}

output "ingest_deploy_role_arn" {
  value = aws_iam_role.ingest_deploy.arn
}

output "receipts_bucket_name" {
  value = aws_s3_bucket.receipts.id
}
