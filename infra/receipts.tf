# Phase 3b infra: private receipts bucket. Lambda code that writes objects
# is a later slice. Terraform never stores receipt bytes.

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "receipts" {
  bucket = "finflow-receipts-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_ownership_controls" "receipts" {
  bucket = aws_s3_bucket.receipts.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "receipts" {
  bucket = aws_s3_bucket.receipts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "receipts" {
  bucket = aws_s3_bucket.receipts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "receipts" {
  bucket = aws_s3_bucket.receipts.id

  rule {
    id     = "glacier-ir-after-1-year"
    status = "Enabled"

    filter {}

    transition {
      days          = 365
      storage_class = "GLACIER_IR"
    }
  }
}

# Deny anything but TLS. Does not grant access to "*".
resource "aws_s3_bucket_policy" "receipts" {
  bucket = aws_s3_bucket.receipts.id

  depends_on = [aws_s3_bucket_public_access_block.receipts]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        aws_s3_bucket.receipts.arn,
        "${aws_s3_bucket.receipts.arn}/*",
      ]
      Condition = {
        Bool = {
          "aws:SecureTransport" = "false"
        }
      }
    }]
  })
}
