# Infrastructure Reference

All infrastructure is managed via `gcloud` CLI. No Terraform.

## Quick reference

| Resource | Name | Notes |
|---|---|---|
| Cloud SQL | `fac-sermons-db` | PostgreSQL 16, db-f1-micro |
| Cloud Run | `fac-mcp-server` | Scales to zero, max 3 |
| GCS Bucket | `fac-sermon-files-<project>` | Sermon .txt files |
| Artifact Registry | `fac-mcp` | Docker images |
| Secrets | `fac-db-password`, `fac-openai-key`, `fac-mcp-api-key` | Secret Manager |

## One-time setup

```bash
./scripts/setup.sh
```

## Deploy MCP server

```bash
./scripts/deploy.sh
```

## Run ingestion locally

```bash
./scripts/ingest-local.sh
```

## Run ingestion as Cloud Run Job

See commented commands in `infra/main.sh`.
