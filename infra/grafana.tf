# Grafana Cloud folder and data source (Phase 5). The stack itself is not
# managed here; dashboards reference the data source by uid only.

# Reads GRAFANA_URL and GRAFANA_AUTH (a stack service-account token) from the
# environment (source them from .env); never Terraform variables.
provider "grafana" {}

resource "grafana_folder" "finflow" {
  title = "FinFlow"
  uid   = "finflow"
}

resource "grafana_data_source" "marts" {
  type = "grafana-postgresql-datasource" # core plugin id ("postgres" is its alias)
  name = "FinFlow marts"
  uid  = "finflow-marts"

  # Session pooler (IPv4), same host and mode as the nightly dbt. Pooler user
  # names are <role>.<project ref>.
  url      = "${var.supabase_pooler_host}:5432"
  username = "finflow_analyst.${supabase_project.finflow.id}"

  json_data_encoded = jsonencode({
    database               = "postgres"
    sslmode                = "verify-full"
    tlsConfigurationMethod = "file-content"
    maxOpenConns           = 3
    maxIdleConns           = 1
    connMaxLifetime        = 300
    # Grafana Cloud adds this to every data source; declaring it keeps the plan
    # free of an in-place update (which would also resend secure data).
    pdcInjected = true
  })

  # The password is deliberately absent: the owner enters the real
  # finflow_analyst password in Grafana (Connections > Data sources) once.
  # Grafana keeps any secure key an update leaves out, so later applies do not
  # touch it. Sending a placeholder here would overwrite it on every in-place
  # update. The CA is public.
  secure_json_data_encoded = jsonencode({
    tlsCACert = file("${path.module}/../supabase/prod-ca-2021.crt")
  })
}

# The JSON is the source of truth: CI checks it (grafana/scripts/
# check_dashboards.py), and an apply overwrites edits made in the UI.
resource "grafana_dashboard" "this_month" {
  folder      = grafana_folder.finflow.uid
  config_json = file("${path.module}/../grafana/dashboards/this-month.json")
  overwrite   = true
}

# Grafana opens on This month. The provider writes every organization
# preference at once, so each apply resets the ones left unset here
# (theme, week start) to Grafana's defaults.
resource "grafana_organization_preferences" "finflow" {
  home_dashboard_uid = grafana_dashboard.this_month.uid
  timezone           = "America/Toronto"
}
