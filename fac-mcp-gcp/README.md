# FAC MCP Server — Google Cloud

MCP Server for FAC Maryville sermon content, hosted on Google Cloud Run.

## Architecture

```
Cloud Storage (sermon .txt files)
    ↓
Cloud Run Job (chunk → embed via OpenAI → Cloud SQL pgvector)
    ↓
Cloud SQL PostgreSQL 16 + pgvector
    ↓
Cloud Run Service (Express.js MCP HTTP server) — scales to zero
    ↓
mcp.facmcp.com (Route 53 CNAME → Cloud Run URL)
```

## First-time setup

```bash
cp .env.example .env
# Fill in GCP_PROJECT_ID, OPENAI_API_KEY, MCP_API_KEY, DB_PASSWORD

./scripts/setup.sh
```

After setup, enable pgvector:
```bash
gcloud sql connect fac-sermons-db --user=facadmin --database=facsermons
# Then run: CREATE EXTENSION IF NOT EXISTS vector;
```

## Scrape YouTube sermons

Scrapes completed livestreams from the FAC Maryville YouTube channel, transcribes via Whisper, filters to sermon content via Claude, and saves as `.txt` files.

**Prerequisites:**
- `pipx install openai-whisper`
- `brew install yt-dlp`
- Export YouTube cookies from Chrome using "Get cookies.txt LOCALLY" extension → save as `youtube-cookies.txt` in project root

**Run:**
```bash
npm install
node scripts/scrape-youtube.mjs --backfill   # all history
node scripts/scrape-youtube.mjs              # last 8 days only
```

**Options:**
```bash
SKIP_MINUTES=30 node scripts/scrape-youtube.mjs --backfill  # skip first 30 min of each video (default: 15)
WHISPER_MODEL=small node scripts/scrape-youtube.mjs --backfill  # use small model (slower, more accurate)
```

**Block non-sermon videos** (weddings, worship-only, etc.) by adding video IDs to `blocked-videos.txt`:
```
jCS9cfDwsTY  # The Wedding of Grant and Brooke Fragasso
```

After scraping, ingest the new files:
```bash
./scripts/ingest-local.sh
```

Failed videos are logged to `failed-scrapes.json` for review.

---

## Ingest sermons (local)

```bash
./scripts/ingest-local.sh
```

This reads from `LOCAL_SERMON_DIR` and inserts into Cloud SQL.
Requires your IP to be authorized in Cloud SQL → Connections → Networking.

## Deploy MCP server

Before first deploy, store secrets:
```bash
echo -n "sk-..." | gcloud secrets create fac-openai-key --data-file=- --replication-policy=automatic
echo -n "your-mcp-api-key" | gcloud secrets create fac-mcp-api-key --data-file=- --replication-policy=automatic
```

Then:
```bash
./scripts/deploy.sh
```

## Claude Desktop config

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

## Cost estimate

~$15/month: Cloud SQL db-f1-micro (~$10) + Cloud Run + Storage + Secrets.
