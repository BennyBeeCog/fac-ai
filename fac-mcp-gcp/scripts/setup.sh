#!/usr/bin/env bash
set -euo pipefail

# ── Load config ────────────────────────────────────────────────────────────────
source "$(dirname "$0")/../.env" 2>/dev/null || true

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID in .env}"
REGION="${GCP_REGION:-us-central1}"
INSTANCE_NAME="fac-sermons-db"
DB_NAME="facsermons"
DB_USER="facadmin"
BUCKET_NAME="${GCS_BUCKET:-fac-sermon-files-${PROJECT_ID}}"
REPO_NAME="fac-mcp"

echo "==> Setting up GCP project: $PROJECT_ID in $REGION"
gcloud config set project "$PROJECT_ID"

echo ""
echo "==> Enabling required APIs..."
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com

echo ""
echo "==> Creating Artifact Registry repository: $REPO_NAME..."
gcloud artifacts repositories create "$REPO_NAME" \
  --repository-format=docker \
  --location="$REGION" \
  --description="FAC MCP Docker images" 2>/dev/null || echo "(already exists)"

echo ""
echo "==> Creating Cloud SQL instance: $INSTANCE_NAME (this takes ~5 minutes)..."
gcloud sql instances create "$INSTANCE_NAME" \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region="$REGION" \
  --no-backup \
  --storage-type=SSD \
  --storage-size=10GB 2>/dev/null || echo "(already exists)"

echo ""
echo "==> Creating database: $DB_NAME..."
gcloud sql databases create "$DB_NAME" --instance="$INSTANCE_NAME" 2>/dev/null || echo "(already exists)"

echo ""
echo "==> Creating DB user: $DB_USER..."
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -base64 24)}"
gcloud sql users create "$DB_USER" \
  --instance="$INSTANCE_NAME" \
  --password="$DB_PASSWORD" 2>/dev/null || gcloud sql users set-password "$DB_USER" \
    --instance="$INSTANCE_NAME" \
    --password="$DB_PASSWORD"

echo ""
echo "==> Enabling pgvector on the instance..."
INSTANCE_CONNECTION_NAME=$(gcloud sql instances describe "$INSTANCE_NAME" --format="value(connectionName)")
echo "    Instance connection name: $INSTANCE_CONNECTION_NAME"
echo "    NOTE: Run this SQL manually after setup:"
echo "          CREATE EXTENSION IF NOT EXISTS vector;"
echo "    Use: gcloud sql connect $INSTANCE_NAME --user=$DB_USER --database=$DB_NAME"

echo ""
echo "==> Storing DB password in Secret Manager..."
echo -n "$DB_PASSWORD" | gcloud secrets create fac-db-password \
  --data-file=- \
  --replication-policy=automatic 2>/dev/null || \
  echo -n "$DB_PASSWORD" | gcloud secrets versions add fac-db-password --data-file=-

echo ""
echo "==> Creating Cloud Storage bucket: $BUCKET_NAME..."
gcloud storage buckets create "gs://$BUCKET_NAME" \
  --location="$REGION" \
  --uniform-bucket-level-access 2>/dev/null || echo "(already exists)"

echo ""
echo "==> Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Enable pgvector: gcloud sql connect $INSTANCE_NAME --user=$DB_USER --database=$DB_NAME"
echo "     Then run: CREATE EXTENSION IF NOT EXISTS vector;"
echo "  2. Upload sermons: gsutil -m cp /Users/benjaminpenton/Documents/BibleAITraining/fac_sermon_training/*.txt gs://$BUCKET_NAME/sermons/"
echo "  3. Update .env with:"
echo "     CLOUD_SQL_CONNECTION_NAME=$INSTANCE_CONNECTION_NAME"
echo "     GCS_BUCKET=$BUCKET_NAME"
echo "     DB_PASSWORD=$DB_PASSWORD"
echo "  4. Run ingestion: ./scripts/ingest-local.sh"
echo "  5. Deploy: ./scripts/deploy.sh"
