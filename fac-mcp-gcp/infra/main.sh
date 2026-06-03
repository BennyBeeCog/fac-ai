#!/usr/bin/env bash
# Reference commands for GCP infrastructure management.
# These are NOT meant to be run as a single script — run each section as needed.

set -euo pipefail
source "$(dirname "$0")/../.env" 2>/dev/null || true

PROJECT_ID="${GCP_PROJECT_ID:?}"
REGION="${GCP_REGION:-us-central1}"
INSTANCE_NAME="fac-sermons-db"

# ── Authorize your local IP for Cloud SQL (for local dev / ingestion) ──────────
# gcloud sql instances patch "$INSTANCE_NAME" \
#   --authorized-networks="$(curl -s https://checkip.amazonaws.com)/32"

# ── Remove your local IP when done ────────────────────────────────────────────
# gcloud sql instances patch "$INSTANCE_NAME" --authorized-networks=""

# ── Get Cloud SQL public IP ────────────────────────────────────────────────────
# gcloud sql instances describe "$INSTANCE_NAME" --format="value(ipAddresses[0].ipAddress)"

# ── Connect to Cloud SQL interactively ────────────────────────────────────────
# gcloud sql connect "$INSTANCE_NAME" --user=facadmin --database=facsermons

# ── Store secrets in Secret Manager ───────────────────────────────────────────
# echo -n "your-openai-key" | gcloud secrets create fac-openai-key --data-file=- --replication-policy=automatic
# echo -n "your-mcp-api-key" | gcloud secrets create fac-mcp-api-key --data-file=- --replication-policy=automatic

# ── Update a secret value ──────────────────────────────────────────────────────
# echo -n "new-value" | gcloud secrets versions add fac-mcp-api-key --data-file=-

# ── List Cloud Run services ────────────────────────────────────────────────────
# gcloud run services list --region="$REGION"

# ── View Cloud Run logs ────────────────────────────────────────────────────────
# gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=fac-mcp-server" \
#   --limit=50 --format="value(textPayload)" --project="$PROJECT_ID"

# ── Upload sermon files to GCS ─────────────────────────────────────────────────
# gsutil -m cp /Users/benjaminpenton/Documents/BibleAITraining/fac_sermon_training/*.txt gs://$GCS_BUCKET/sermons/

# ── Run ingestion as Cloud Run Job ────────────────────────────────────────────
# REGION="${REGION}" REPO_NAME="fac-mcp" PROJECT_ID="${PROJECT_ID}"
# IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/fac-mcp/fac-ingestion-job:latest"
#
# cd jobs/ingestion
# docker build --platform linux/amd64 -t "$IMAGE" .
# docker push "$IMAGE"
#
# gcloud run jobs create fac-ingestion \
#   --image="$IMAGE" \
#   --region="$REGION" \
#   --add-cloudsql-instances="$CLOUD_SQL_CONNECTION_NAME" \
#   --set-env-vars="MODE=gcs,GCS_BUCKET=$GCS_BUCKET,CLOUD_SQL_CONNECTION_NAME=$CLOUD_SQL_CONNECTION_NAME,DB_NAME=facsermons,DB_USER=facadmin" \
#   --set-secrets="DB_PASSWORD=fac-db-password:latest,OPENAI_API_KEY=fac-openai-key:latest" \
#   --memory=512Mi \
#   --task-timeout=3600
#
# gcloud run jobs execute fac-ingestion --region="$REGION" --wait

# ── Grant Cloud Run service account access to Secret Manager ──────────────────
# SA=$(gcloud run services describe fac-mcp-server --region="$REGION" --format="value(spec.template.spec.serviceAccountName)")
# gcloud projects add-iam-policy-binding "$PROJECT_ID" \
#   --member="serviceAccount:$SA" \
#   --role="roles/secretmanager.secretAccessor"

# ── Delete everything (careful!) ──────────────────────────────────────────────
# gcloud run services delete fac-mcp-server --region="$REGION" --quiet
# gcloud sql instances delete "$INSTANCE_NAME" --quiet
# gcloud storage buckets delete "gs://$GCS_BUCKET" --recursive
