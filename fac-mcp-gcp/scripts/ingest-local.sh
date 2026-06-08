#!/usr/bin/env bash
set -euo pipefail

# Runs ingestion locally against local sermon .txt files.
# Connects to Cloud SQL via public IP (authorize your IP in Cloud SQL → Connections → Networking).
# Or run Cloud SQL Auth Proxy locally: cloud-sql-proxy $CLOUD_SQL_CONNECTION_NAME

# Save any values passed in before .env overrides them
_SERMON_DIR="${LOCAL_SERMON_DIR:-}"
_COLLECTION="${COLLECTION_ID:-}"

source "$(dirname "$0")/../.env" 2>/dev/null || true

: "${DB_HOST:?Set DB_HOST in .env (Cloud SQL public IP or 127.0.0.1 if using Auth Proxy)}"
: "${DB_PASSWORD:?Set DB_PASSWORD in .env}"
: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID in .env}"
# Vertex AI auth uses application default credentials — run 'gcloud auth application-default login' if needed

SERMON_DIR="${_SERMON_DIR:-${LOCAL_SERMON_DIR:-/Users/benjaminpenton/Documents/BibleAITraining/fac_sermon_training}}"
COLLECTION="${_COLLECTION:-${COLLECTION_ID:-fac-sermons}}"

echo "==> Running local ingestion"
echo "    Sermons:    $SERMON_DIR"
echo "    Collection: $COLLECTION"
echo "    DB:         $DB_HOST / ${DB_NAME:-facsermons}"
echo ""

cd "$(dirname "$0")/../jobs/ingestion"

if [ ! -d node_modules ]; then
  echo "==> Installing dependencies..."
  npm install
fi

MODE=local \
LOCAL_SERMON_DIR="$SERMON_DIR" \
COLLECTION_ID="$COLLECTION" \
GCP_PROJECT_ID="${GCP_PROJECT_ID}" \
GCP_REGION="${GCP_REGION:-us-central1}" \
DB_HOST="${DB_HOST}" \
DB_NAME="${DB_NAME:-facsermons}" \
DB_USER="${DB_USER:-facadmin}" \
DB_PASSWORD="${DB_PASSWORD}" \
node index.mjs
