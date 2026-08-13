terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.58"
    }
    supabase = {
      source  = "supabase/supabase"
      version = "~> 1.10"
    }
    grafana = {
      source  = "grafana/grafana"
      version = "~> 4.44"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Local state only. State embeds secrets; this repo is public.
  # Do not add a remote backend.
}

# supabase and grafana providers are pinned above and configured in the
# phases that first create their resources (1 and 5). Declaring them here
# lets `terraform init` install them without requiring their credentials yet.
