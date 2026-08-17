variable "budget_alert_email" {
  description = "Email that receives the $1/month AWS budget alerts. Set in terraform.tfvars (gitignored)."
  type        = string
  sensitive   = true
}

variable "supabase_organization_id" {
  description = "Supabase organization slug/id that owns the project. Set in terraform.tfvars (gitignored)."
  type        = string
}

variable "github_repository" {
  description = "GitHub repo (owner/name) allowed to assume the ingest deploy role via OIDC."
  type        = string
}

# Repos created after 2026-07-15 emit immutable owner/repo ids in the OIDC
# `sub` claim (repo:owner@OWNER_ID/name@REPO_ID:…). Name-only matching fails.
# IDs are public: GET https://api.github.com/repos/<owner>/<name>
variable "github_owner_id" {
  description = "Numeric GitHub user or org id for the OIDC sub claim."
  type        = string
}

variable "github_repo_id" {
  description = "Numeric GitHub repository id for the OIDC sub claim."
  type        = string
}
