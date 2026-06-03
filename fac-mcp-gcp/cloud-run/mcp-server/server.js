import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { Connector } from '@google-cloud/cloud-sql-connector';
import { GoogleAuth } from 'google-auth-library';
import pg from 'pg';

const { Pool } = pg;
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.MCP_API_KEY;
const CLOUD_SQL_CONNECTION_NAME = process.env.CLOUD_SQL_CONNECTION_NAME;
const DB_HOST = process.env.DB_HOST;
const DB_NAME = process.env.DB_NAME || 'facsermons';
const DB_USER = process.env.DB_USER || 'facadmin';
const DB_PASSWORD = process.env.DB_PASSWORD;
const SERVICE_URL = process.env.SERVICE_URL || 'https://mcp.facmcp.com';

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GCP_REGION = process.env.GCP_REGION || 'us-central1';
const VERTEX_REGION = 'us-central1';
const EMBEDDING_MODEL = 'text-embedding-005';
const EMBEDDING_DIMS = 768;

const vertexAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

let dbPool = null;

// ── DB connection ──────────────────────────────────────────────────────────────
async function getDbPool() {
  if (dbPool) return dbPool;

  if (CLOUD_SQL_CONNECTION_NAME) {
    const connector = new Connector();
    const clientOpts = await connector.getOptions({
      instanceConnectionName: CLOUD_SQL_CONNECTION_NAME,
      ipType: 'PUBLIC',
    });
    dbPool = new Pool({
      ...clientOpts,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      max: 10,
      idleTimeoutMillis: 30000,
    });
    console.log('[db] Pool connected via Cloud SQL connector:', CLOUD_SQL_CONNECTION_NAME);
  } else {
    dbPool = new Pool({
      host: DB_HOST,
      database: DB_NAME,
      user: DB_USER,
      password: DB_PASSWORD,
      port: 5432,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
    });
    console.log('[db] Pool connected via direct TCP:', DB_HOST);
  }

  return dbPool;
}

// ── Key/usage schema init ──────────────────────────────────────────────────────
async function initKeySchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      email TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      is_active BOOLEAN DEFAULT TRUE,
      request_count INTEGER DEFAULT 0,
      notes TEXT DEFAULT ''
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id SERIAL PRIMARY KEY,
      api_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tool_name TEXT,
      query TEXT,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      response_time_ms INTEGER,
      success BOOLEAN DEFAULT TRUE
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS usage_logs_api_key_idx ON usage_logs (api_key)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS usage_logs_user_id_idx ON usage_logs (user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS usage_logs_ts_idx ON usage_logs (timestamp DESC)`);
  console.log('[keys] Schema ready');
}

// ── Migrate existing env var key into DB ───────────────────────────────────────
async function migrateEnvKey(pool) {
  if (!API_KEY) return;
  const existing = await pool.query('SELECT key FROM api_keys WHERE key = $1', [API_KEY]);
  if (existing.rows.length === 0) {
    await pool.query(
      `INSERT INTO api_keys (key, user_id, user_name, notes) VALUES ($1, $2, $3, $4)`,
      [API_KEY, 'admin', 'Admin', 'Migrated from MCP_API_KEY env var']
    );
    console.log('[keys] Registered MCP_API_KEY in api_keys table');
  }
}

// ── Fire-and-forget usage logging ──────────────────────────────────────────────
function logUsage(apiKey, userId, toolName, query, responseTimeMs, success) {
  getDbPool().then(pool => {
    pool.query(
      `INSERT INTO usage_logs (api_key, user_id, tool_name, query, response_time_ms, success)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [apiKey, userId, toolName, query || '', responseTimeMs, success]
    ).catch(err => console.error('[usage] log error:', err.message));

    pool.query(
      `UPDATE api_keys SET last_used_at = NOW(), request_count = request_count + 1 WHERE key = $1`,
      [apiKey]
    ).catch(err => console.error('[usage] key update error:', err.message));
  }).catch(err => console.error('[usage] pool error:', err.message));
}

// ── Embed via Vertex AI ────────────────────────────────────────────────────────
async function embedText(text) {
  const client = await vertexAuth.getClient();
  const token = await client.getAccessToken();
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/${VERTEX_REGION}/publishers/google/models/${EMBEDDING_MODEL}:predict`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instances: [{ content: text }] }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Vertex AI embed failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.predictions[0].embeddings.values;
  } finally {
    clearTimeout(timeout);
  }
}

// ── MCP Tool definitions ───────────────────────────────────────────────────────
const tools = [
  {
    name: 'query_documents',
    description: 'Search the FAC Maryville sermon archive using semantic similarity. Returns the most relevant sermon excerpts for a given query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The theological question or topic to search for' },
        limit: { type: 'number', description: 'Number of results to return (default 5, max 20)', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_files',
    description: 'List all sermon files that have been ingested into the archive.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'status',
    description: 'Get database statistics — total chunks, files, and system health.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function handleToolCall(name, args) {
  const pool = await getDbPool();

  if (name === 'query_documents') {
    const { query, limit = 5 } = args;
    const safeLimit = Math.min(Number(limit) || 5, 20);

    const embedding = await embedText(query);
    const result = await pool.query(
      `SELECT file_key, filename, chunk_index, content,
              1 - (embedding <=> $1::vector) AS similarity
       FROM sermon_chunks
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [JSON.stringify(embedding), safeLimit]
    );

    if (result.rows.length === 0) {
      return { content: [{ type: 'text', text: 'No relevant sermon content found for that query.' }] };
    }

    const formatted = result.rows.map((row, i) =>
      `[${i + 1}] ${row.filename} (chunk ${row.chunk_index}, similarity: ${(row.similarity * 100).toFixed(1)}%)\n${row.content}`
    ).join('\n\n---\n\n');

    return { content: [{ type: 'text', text: formatted }] };
  }

  if (name === 'list_files') {
    const result = await pool.query(
      `SELECT filename, COUNT(*) as chunk_count, MAX(created_at) as ingested_at
       FROM sermon_chunks
       GROUP BY filename
       ORDER BY filename`
    );

    const formatted = result.rows.map(r =>
      `${r.filename} — ${r.chunk_count} chunks (ingested: ${new Date(r.ingested_at).toLocaleDateString()})`
    ).join('\n');

    return { content: [{ type: 'text', text: formatted || 'No files ingested yet.' }] };
  }

  if (name === 'status') {
    const chunks = await pool.query('SELECT COUNT(*) as total FROM sermon_chunks');
    const files = await pool.query('SELECT COUNT(DISTINCT filename) as total FROM sermon_chunks');
    const keys = await pool.query('SELECT COUNT(*) as total FROM api_keys WHERE is_active = TRUE');

    return {
      content: [{
        type: 'text',
        text: `FAC Sermon Archive Status:\n- Total chunks: ${chunks.rows[0].total}\n- Total sermons: ${files.rows[0].total}\n- Active API keys: ${keys.rows[0].total}\n- DB: ${CLOUD_SQL_CONNECTION_NAME || DB_HOST}\n- Embedding model: ${EMBEDDING_MODEL} (${EMBEDDING_DIMS}d, Vertex AI)`,
      }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ── Auth middleware (DB-backed) ────────────────────────────────────────────────
async function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key']
    || req.headers['authorization']?.replace('Bearer ', '')
    || req.query['api-key'];

  if (!key) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const pool = await getDbPool();
    const result = await pool.query(
      `SELECT user_id, user_name, email FROM api_keys WHERE key = $1 AND is_active = TRUE`,
      [key]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Unauthorized' });
    req.user = result.rows[0];
    req.apiKey = key;
    next();
  } catch (err) {
    // Fallback to env var if DB unavailable
    console.error('[auth] DB error, falling back to env var:', err.message);
    if (API_KEY && key === API_KEY) {
      req.user = { user_id: 'admin', user_name: 'Admin' };
      req.apiKey = key;
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// ── OAuth discovery ────────────────────────────────────────────────────────────
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.status(200).json({
    issuer: SERVICE_URL,
    authorization_endpoint: `${SERVICE_URL}/auth`,
    token_endpoint: `${SERVICE_URL}/token`,
    registration_endpoint: `${SERVICE_URL}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
  });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const pool = await getDbPool();
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.json({ status: 'ok', db: 'connecting' });
  }
});

// ── MCP POST ──────────────────────────────────────────────────────────────────
app.post('/mcp', requireApiKey, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] || randomUUID();
  const message = req.body;

  res.setHeader('mcp-session-id', sessionId);
  res.setHeader('Content-Type', 'application/json');

  try {
    if (message.method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fac-sermon-mcp', version: '1.0.0' },
        },
      });
    }

    if (message.method === 'notifications/initialized') {
      return res.status(200).send();
    }

    if (message.method === 'tools/list') {
      return res.json({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools },
      });
    }

    if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;
      const startTime = Date.now();
      console.log(`[tool] ${name} user=${req.user?.user_id}`, JSON.stringify(args));

      try {
        const result = await handleToolCall(name, args || {});
        logUsage(req.apiKey, req.user?.user_id, name, args?.query || '', Date.now() - startTime, true);
        return res.json({ jsonrpc: '2.0', id: message.id, result });
      } catch (toolErr) {
        logUsage(req.apiKey, req.user?.user_id, name, args?.query || '', Date.now() - startTime, false);
        throw toolErr;
      }
    }

    return res.json({
      jsonrpc: '2.0',
      id: message.id ?? null,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    });

  } catch (err) {
    console.error('[/mcp] error:', err.message);
    return res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: err.message },
      id: message.id ?? null,
    });
  }
});

// ── SSE GET ────────────────────────────────────────────────────────────────────
app.get('/mcp', requireApiKey, (req, res) => {
  const sessionId = req.headers['mcp-session-id'] || randomUUID();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('mcp-session-id', sessionId);
  res.flushHeaders();
  const ping = setInterval(() => res.write(': ping\n\n'), 30000);
  req.on('close', () => clearInterval(ping));
});

// ── DELETE ────────────────────────────────────────────────────────────────────
app.delete('/mcp', requireApiKey, (req, res) => res.status(204).send());

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`FAC MCP Server (GCP) running on port ${PORT}`);
  console.log(`CLOUD_SQL_CONNECTION_NAME: ${CLOUD_SQL_CONNECTION_NAME || '(not set — using DB_HOST)'}`);
  console.log(`GCP_PROJECT_ID: ${GCP_PROJECT_ID || 'NOT SET'}`);
  console.log(`Embedding: ${EMBEDDING_MODEL} via Vertex AI`);

  try {
    const pool = await getDbPool();
    await initKeySchema(pool);
    await migrateEnvKey(pool);
    console.log('[startup] DB connection established');
  } catch (err) {
    console.error('[startup] DB connection failed:', err.message);
  }
});
