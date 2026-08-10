variable "budget_alert_email" {
  description = "Email that receives the $1/month AWS budget alerts. Set in terraform.tfvars (gitignored)."
  type        = string
  sensitive   = true
}
