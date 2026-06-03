# FAC MCP Server — Google Cloud Build Instructions
> Drop this file into Claude Code at ~/fac-mcp-gcp/ to build the GCP version from scratch.

---

## Project Overview
Build a Google Cloud-hosted MCP Server for FAC Maryville sermon content. Allows Claude Desktop and a React PWA chat app to answer theological questions strictly from the FAC Maryville sermon archive.

**Reference code:** `~/fac-mcp-server/` contains the AWS version — use it for MCP server logic and ingestion patterns. Do NOT copy infrastructure code.

**Source sermon files:** `/Users/benjaminpenton/Documents/BibleAITraining/fac_sermon_training/` — 143+ .txt files, these are the raw input for ingestion.

---

## Target Architecture

```
Cloud Storage (sermon .txt files)
    ↓
Cloud Run Job (chunk → embed via OpenAI → Cloud SQL pgvector)
    ↓
Cloud SQL PostgreSQL 16 + pgvector
    ↓
Cloud Run Service (Express.js MCP HTTP server) — scales to zero
    ↓
Custom Domain (mcp.facmcp.com via Route 53 CNAME → Cloud Run URL)
```

**Target cost: ~$15-20/month**

---

## Embedding Model
- **Model:** OpenAI `text-embedding-3-small`
- **Dimensions:** 1536
- **Cost:** ~$0.02/million tokens (~$0.001 total for 143 sermons)
- **No AWS dependency** — completely GCP + OpenAI

---

## Database Schema
```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS sermon_chunks (
  id SERIAL PRIMARY KEY,
  file_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX sermon_chunks_embedding_idx 
  ON sermon_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX sermon_chunks_file_key_idx ON sermon_chunks (file_key);
```

---

## Chunking Settings
- Chunk size: **512 characters**
- Chunk overlap: **100 characters**

---

## MCP Server Requirements
- Express.js HTTP server
- 3 tools: `query_documents`, `list_files`, `status`
- API key auth via `x-api-key` header
- Streamable HTTP MCP protocol (required for Claude Desktop via mcp-remote)
- Reference implementation: `~/fac-mcp-server/docker/mcp-server/server.js`
- Deploy as Cloud Run service

### query_documents tool
- Embed query using OpenAI `text-embedding-3-small`
- Cosine similarity search in pgvector
- Return top 5 most relevant chunks with filename and content

### list_files tool
- List all distinct filenames in sermon_chunks with chunk count
- Group by filename, count chunks

### status tool
- Return total chunk count, total sermon count, DB host, embedding model name

---

## Project Structure to Build

```
~/fac-mcp-gcp/
├── CLAUDE.md                      # This file
├── README.md
├── .env.example
├── .gitignore
├── cloud-run/
│   └── mcp-server/
│       ├── Dockerfile             # Node 22, simple
│       ├── package.json
│       └── server.js              # MCP HTTP server
├── jobs/
│   └── ingestion/
│       ├── Dockerfile
│       ├── package.json
│       └── index.mjs              # Reads .txt files, chunks, embeds, inserts
├── scripts/
│   ├── setup.sh                   # One-time GCP setup (enable APIs, create resources)
│   ├── deploy.sh                  # Deploy Cloud Run service
│   └── ingest-local.sh            # Run ingestion from local sermon files
└── infra/
    ├── main.sh                    # gcloud CLI commands (no Terraform needed)
    └── README.md
```

---

## Build Order

### Step 1 — GCP Project Setup
```bash
# Enable required APIs
gcloud services enable run.googleapis.com
gcloud services enable sqladmin.googleapis.com
gcloud services enable storage.googleapis.com
gcloud services enable secretmanager.googleapis.com
gcloud services enable artifactregistry.googleapis.com
```

### Step 2 — Cloud SQL
- PostgreSQL 16 instance
- Machine type: `db-f1-micro` (~$10/month)
- Enable pgvector extension
- Create database `facsermons`
- Create user `facadmin`
- Store password in Secret Manager

### Step 3 — Cloud Storage
- Create bucket for sermon .txt files
- Upload from local: `gsutil -m cp /Users/benjaminpenton/Documents/BibleAITraining/fac_sermon_training/*.txt gs://BUCKET/sermons/`

### Step 4 — Ingestion Job
- Cloud Run Job that reads sermon .txt files
- Chunks each file (512 chars, 100 overlap)
- Embeds each chunk via OpenAI `text-embedding-3-small`
- Inserts into Cloud SQL pgvector
- Idempotent: DELETE existing chunks for file before inserting
- Add 50ms delay between OpenAI API calls to avoid rate limits
- Run locally first to test, then as Cloud Run Job

### Step 5 — MCP Server
- Express.js server adapted from `~/fac-mcp-server/docker/mcp-server/server.js`
- Connect to Cloud SQL via Cloud SQL Node.js connector (`@google-cloud/cloud-sql-connector`)
- Deploy to Cloud Run
- Set min instances to 0 (scales to zero when idle)
- Set max instances to 3

### Step 6 — Custom Domain
- Get Cloud Run service URL
- In Route 53 (AWS): add CNAME record `mcp.facmcp.com` → Cloud Run URL
- Or use Cloud Run domain mapping if preferred

---

## Environment Variables

```bash
# GCP
GCP_PROJECT_ID=your-project-id
CLOUD_SQL_CONNECTION_NAME=project:region:instance-name
DB_NAME=facsermons
DB_USER=facadmin
DB_PASSWORD=your-password

# OpenAI
OPENAI_API_KEY=your-openai-key

# App
MCP_API_KEY=your-mcp-api-key
PORT=3000
```

---

## GCP Services & Costs

| Service | Config | Est. Cost |
|---|---|---|
| Cloud Run (MCP server) | Scales to zero | ~$0-3/month |
| Cloud SQL | db-f1-micro, PostgreSQL 16 | ~$10/month |
| Cloud Storage | Standard, ~1GB | ~$0.50/month |
| Secret Manager | ~5 secrets | ~$0.50/month |
| Artifact Registry | Container images | ~$0.50/month |
| **Total** | | **~$15/month** |

---

## Claude Desktop Config (after deploy)
```json
{
  "mcpServers": {
    "fac-sermons": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.facmcp.com/mcp",
        "--header",
        "x-api-key:YOUR_MCP_API_KEY",
        "--transport",
        "http-only"
      ]
    }
  }
}
```

---

## Key Constraints
- **DO NOT use Kubernetes, GKE, or any container orchestration** — Cloud Run only
- **DO NOT create VPCs** unless Cloud SQL requires it — keep it simple
- **Keep MCP protocol exactly as-is** — Claude Desktop requires Streamable HTTP
- **Keep API key auth** — `x-api-key` header, same key as before
- **Idempotent ingestion** — always DELETE existing chunks before inserting
- **This serves ~5-200 users** — no need for enterprise-scale complexity

---

## Notes on AWS Version Problems (avoid these)
- Fixed resource names in IaC cause replace failures — use generated names or import
- ECS + VPC + RDS = too many moving parts for a simple app
- NAT Gateway alone costs $32/month — Cloud Run has no NAT gateway
- RDS ENIs linger for hours after deletion — Cloud SQL doesn't have this problem
- CDK rollbacks cascade badly — use simple gcloud CLI scripts instead