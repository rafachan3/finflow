variable "budget_alert_email" {
  description = "Email that receives the $1/month AWS budget alerts. Set in terraform.tfvars (gitignored)."
  type        = string
  sensitive   = true
}

variable "supabase_organization_id" {
  description = "Supabase organization slug/id that owns the project. Set in terraform.tfvars (gitignored)."
  type        = string
}
