# One command per check, the same ones CI runs (.github/workflows/ci.yml).
# Targets that need Postgres get a throwaway container from
# scripts/with-test-db.sh, removed on exit; with TEST_DATABASE_URL set they
# use that database instead, as CI does. See docs/TESTING.md.

.DEFAULT_GOAL := help
# Database targets share finflow_test when TEST_DATABASE_URL is set.
.NOTPARALLEL:
.PHONY: help check test-unit test-integration inventory dbt-build dashboards eval

PYTHON ?= python3.12
# CI installs dbt into its own Python and passes DBT_VENV= (empty).
DBT_VENV ?= dbt/.venv
# Every recipe that uses it runs from a top-level directory.
WITH_DB := ../scripts/with-test-db.sh
NODE_DEPS := lambda/node_modules/.package-lock.json
DBT_PATH := $(if $(DBT_VENV),$(abspath $(DBT_VENV))/bin:)

help: ## List the targets
	@echo "make <target>"
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  %-17s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

check: test-unit test-integration inventory dbt-build dashboards ## Every CI check except the live eval

test-unit: $(NODE_DEPS) ## Typecheck, unit tests, both Lambda bundles (CI job unit)
	cd lambda && npm run build && npm run test:unit && npm run bundle && npm run bundle:nudge

test-integration: $(NODE_DEPS) ## Integration tests and journeys on a throwaway Postgres (CI job integration)
	cd lambda && $(WITH_DB) npm run test:integration

inventory: $(NODE_DEPS) ## TESTING.md cites real tests, and the coverage floor holds (CI job inventory)
	node scripts/check-inventory.mjs
	cd lambda && $(WITH_DB) npm run test:coverage

dbt-build: $(if $(DBT_VENV),$(DBT_VENV)/bin/dbt) ## dbt build on the synthetic fixture (first step of CI job dbt)
	cd dbt && DBT_PARTIAL_PARSE=false PATH="$(DBT_PATH)$$PATH" $(WITH_DB) sh -c 'env=$$(python scripts/test_db.py) && eval "$$env" && dbt build'

dashboards: $(if $(DBT_VENV),$(DBT_VENV)/bin/dbt) ## Grafana dashboards: structure, privacy, every query as finflow_analyst (step of CI job dbt)
	cd dbt && DBT_PARTIAL_PARSE=false PATH="$(DBT_PATH)$$PATH" $(WITH_DB) sh -c 'env=$$(python scripts/test_db.py) && eval "$$env" && dbt run --quiet && python ../grafana/scripts/check_dashboards.py'

# Not in check: it calls Gemini and spends the free-tier quota.
eval: $(NODE_DEPS) ## Golden cases, live Gemini where a request changed (needs GEMINI_EVAL_API_KEY)
	cd lambda && $(WITH_DB) npm run eval

$(NODE_DEPS): lambda/package-lock.json
	cd lambda && npm ci

ifneq ($(DBT_VENV),)
$(DBT_VENV)/bin/dbt: dbt/requirements.txt
	@command -v $(PYTHON) >/dev/null || { echo "$(PYTHON) not found: dbt needs Python 3.12 (or pass PYTHON=...)"; exit 1; }
	$(PYTHON) -m venv $(DBT_VENV)
	$(DBT_VENV)/bin/pip install -r dbt/requirements.txt
	touch $@
endif
