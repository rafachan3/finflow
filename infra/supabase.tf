# Supabase project (Phase 1). Schema is NOT managed here — it lives in
# supabase/migrations/ and ships via `supabase db push`.

# Reads SUPABASE_ACCESS_TOKEN from the environment (source it from .env);
# never a Terraform variable.
provider "supabase" {}

# Bootstrap-only password so the resource can be created without ever
# putting the real secret in state: ignore_changes below means Terraform
# never touches the password again, and the owner rotates it in the
# Supabase dashboard immediately after the first apply. The value that
# remains in (local, gitignored) state is dead.
resource "random_password" "db_bootstrap" {
  length  = 32
  special = false
}

resource "supabase_project" "finflow" {
  organization_id   = var.supabase_organization_id
  name              = "finflow"
  database_password = random_password.db_bootstrap.result
  region            = "ca-central-1"

  lifecycle {
    ignore_changes = [database_password]
  }
}

output "supabase_project_ref" {
  value       = supabase_project.finflow.id
  description = "Project ref for `supabase link --project-ref`"
}
