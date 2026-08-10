# Phase 0: FinFlow-only cost guardrail. Remaining AWS / Supabase / Grafana
# resources are added in the roadmap phase that first needs them.

# Cost allocation tags must be Active before Budgets can filter on them.
# Activation can take up to 24h to show in Cost Explorer / Budgets.
resource "aws_ce_cost_allocation_tag" "project" {
  tag_key = "Project"
  status  = "Active"
}

resource "aws_budgets_budget" "monthly" {
  name         = "finflow-monthly"
  budget_type  = "COST"
  limit_amount = "1.0"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Only spend on resources tagged Project=finflow (see providers.tf
  # default_tags). Untagged account spend is ignored.
  cost_filter {
    name = "TagKeyValue"
    values = [
      "user:Project$finflow",
    ]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  depends_on = [aws_ce_cost_allocation_tag.project]
}
