provider "aws" {
  region = "ca-central-1"

  default_tags {
    tags = {
      Project   = "finflow"
      ManagedBy = "terraform"
    }
  }
}
