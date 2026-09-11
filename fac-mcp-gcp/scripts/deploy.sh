#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/../.env" 2>/dev/null || true

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID in .env}"
REGION="${GCP_REGION:-us-central1}"
REPO_NAME="fac-mcp"
SERVICE_NAME="fac-mcp-server"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO_NAME/$SERVICE_NAME:latest"

echo "==> Building and deploying MCP server from source..."
cd "$(dirname "$0")/../cloud-run/mcp-server"

echo ""
echo "==> Deploying Cloud Run service: $SERVICE_NAME..."
gcloud run deploy "$SERVICE_NAME" \
  --source=. \
  --platform=managed \
  --region="$REGION" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=3 \
  --memory=512Mi \
  --cpu=1 \
  --port=3000 \
  --add-cloudsql-instances="${CLOUD_SQL_CONNECTION_NAME:?Set CLOUD_SQL_CONNECTION_NAME in .env}" \
  --set-env-vars="CLOUD_SQL_CONNECTION_NAME=${CLOUD_SQL_CONNECTION_NAME},DB_NAME=${DB_NAME:-facsermons},DB_USER=${DB_USER:-facadmin},GCP_PROJECT_ID=${PROJECT_ID},GCP_REGION=${REGION}" \
  --set-secrets="DB_PASSWORD=fac-db-password:latest,MCP_API_KEY=fac-mcp-api-key:latest"

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --format="value(status.url)")

echo ""
echo "==> NOTE: Cloud Run service account needs Vertex AI access."
echo "    If this is the first deploy, grant it:"
echo "    SA=\$(gcloud run services describe $SERVICE_NAME --region=$REGION --format='value(spec.template.spec.serviceAccountName)')"
echo "    gcloud projects add-iam-policy-binding $PROJECT_ID --member=\"serviceAccount:\$SA\" --role=roles/aiplatform.user"
echo ""
echo "==> Deployed! Service URL: $SERVICE_URL"
echo ""
echo "Test it:"
echo "  curl $SERVICE_URL/health"
echo "  curl -X POST $SERVICE_URL/mcp -H 'Content-Type: application/json' -H 'x-api-key: YOUR_KEY' \\"
echo "       -d '{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":1}'"
echo ""
echo "Add to Route 53: CNAME mcp.facmcp.com → ${SERVICE_URL#https://}"
