import express from 'express';
import cors from 'cors';
import { randomUUID, randomBytes } from 'crypto';
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

// ── Schema init ────────────────────────────────────────────────────────────────
async function initSchema(pool) {
  // Collections table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      tool_description TEXT DEFAULT 'Search the document archive using semantic similarity.',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add collection_id to sermon_chunks if not exists
  await pool.query(`
    ALTER TABLE sermon_chunks ADD COLUMN IF NOT EXISTS collection_id TEXT DEFAULT 'fac-sermons'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS sermon_chunks_collection_idx ON sermon_chunks (collection_id)
  `);

  // API keys table with collection_ids
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
      notes TEXT DEFAULT '',
      collection_ids TEXT[]
    )
  `);
  await pool.query(`
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS collection_ids TEXT[]
  `);

  // Usage logs
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id SERIAL PRIMARY KEY,
      api_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tool_name TEXT,
      query TEXT,
      collection_id TEXT,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      response_time_ms INTEGER,
      success BOOLEAN DEFAULT TRUE
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS usage_logs_api_key_idx ON usage_logs (api_key)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS usage_logs_user_id_idx ON usage_logs (user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS usage_logs_ts_idx ON usage_logs (timestamp DESC)`);

  // Ensure default fac-sermons collection exists
  await pool.query(`
    INSERT INTO collections (id, name, description, tool_description)
    VALUES ('fac-sermons', 'FAC Maryville Sermons',
      'Sermon archive from First Apostolic Church of Maryville, TN.',
      'Search the FAC Maryville sermon archive using semantic similarity. Returns relevant sermon excerpts for theological questions.')
    ON CONFLICT (id) DO NOTHING
  `);

  console.log('[schema] Ready');
}

// ── Migrate existing env var key ───────────────────────────────────────────────
async function migrateEnvKey(pool) {
  if (!API_KEY) return;
  const existing = await pool.query('SELECT key FROM api_keys WHERE key = $1', [API_KEY]);
  if (existing.rows.length === 0) {
    await pool.query(
      `INSERT INTO api_keys (key, user_id, user_name, notes, collection_ids)
       VALUES ($1, $2, $3, $4, $5)`,
      [API_KEY, 'admin', 'Admin', 'Migrated from MCP_API_KEY env var', null]
    );
    console.log('[keys] Registered MCP_API_KEY (admin, all collections)');
  }
}

// ── Fire-and-forget usage logging ──────────────────────────────────────────────
function logUsage(apiKey, userId, toolName, query, collectionId, responseTimeMs, success) {
  getDbPool().then(pool => {
    pool.query(
      `INSERT INTO usage_logs (api_key, user_id, tool_name, query, collection_id, response_time_ms, success)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [apiKey, userId, toolName, query || '', collectionId || null, responseTimeMs, success]
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

// ── Get collection info ────────────────────────────────────────────────────────
async function getCollection(pool, collectionId) {
  const result = await pool.query('SELECT * FROM collections WHERE id = $1', [collectionId]);
  return result.rows[0] || null;
}

// ── Build MCP tools for a collection ──────────────────────────────────────────
function buildTools(collection) {
  const desc = collection?.tool_description
    || 'Search the document archive using semantic similarity.';
  return [
    {
      name: 'query_documents',
      description: desc,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The question or topic to search for' },
          limit: { type: 'number', description: 'Number of results to return (default 5, max 20)', default: 5 },
        },
        required: ['query'],
      },
    },
    {
      name: 'list_files',
      description: 'List all documents that have been ingested into the archive.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'status',
      description: 'Get archive statistics — total chunks, documents, and system health.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

// ── Tool handlers ──────────────────────────────────────────────────────────────
async function handleToolCall(name, args, collectionIds) {
  const pool = await getDbPool();

  // Build WHERE clause for collection filtering
  const hasFilter = collectionIds && collectionIds.length > 0;
  const collectionFilter = hasFilter
    ? `AND collection_id = ANY($${name === 'query_documents' ? 3 : 1})`
    : '';

  if (name === 'query_documents') {
    const { query, limit = 5 } = args;
    const safeLimit = Math.min(Number(limit) || 5, 20);
    const embedding = await embedText(query);

    const params = [JSON.stringify(embedding), safeLimit];
    if (hasFilter) params.push(collectionIds);

    const result = await pool.query(
      `SELECT file_key, filename, chunk_index, content, collection_id,
              1 - (embedding <=> $1::vector) AS similarity
       FROM sermon_chunks
       WHERE 1=1 ${collectionFilter}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      params
    );

    if (result.rows.length === 0) {
      return { content: [{ type: 'text', text: 'No relevant content found for that query.' }] };
    }

    const showCollection = !hasFilter || collectionIds.length > 1;
    const formatted = result.rows.map((row, i) => {
      const source = showCollection ? ` [${row.collection_id}]` : '';
      return `[${i + 1}]${source} ${row.filename} (chunk ${row.chunk_index}, similarity: ${(row.similarity * 100).toFixed(1)}%)\n${row.content}`;
    }).join('\n\n---\n\n');

    return { content: [{ type: 'text', text: formatted }] };
  }

  if (name === 'list_files') {
    const params = hasFilter ? [collectionIds] : [];
    const result = await pool.query(
      `SELECT filename, collection_id, COUNT(*) as chunk_count, MAX(created_at) as ingested_at
       FROM sermon_chunks
       WHERE 1=1 ${hasFilter ? 'AND collection_id = ANY($1)' : ''}
       GROUP BY filename, collection_id
       ORDER BY collection_id, filename`,
      params
    );

    const formatted = result.rows.map(r =>
      `[${r.collection_id}] ${r.filename} — ${r.chunk_count} chunks (ingested: ${new Date(r.ingested_at).toLocaleDateString()})`
    ).join('\n');

    return { content: [{ type: 'text', text: formatted || 'No files ingested yet.' }] };
  }

  if (name === 'status') {
    const params = hasFilter ? [collectionIds] : [];
    const chunks = await pool.query(
      `SELECT COUNT(*) as total FROM sermon_chunks WHERE 1=1 ${hasFilter ? 'AND collection_id = ANY($1)' : ''}`,
      params
    );
    const files = await pool.query(
      `SELECT COUNT(DISTINCT filename) as total FROM sermon_chunks WHERE 1=1 ${hasFilter ? 'AND collection_id = ANY($1)' : ''}`,
      params
    );
    const keys = await pool.query('SELECT COUNT(*) as total FROM api_keys WHERE is_active = TRUE');
    const cols = await pool.query(
      `SELECT c.id, c.name, COUNT(DISTINCT sc.filename) as doc_count
       FROM collections c
       LEFT JOIN sermon_chunks sc ON sc.collection_id = c.id
       WHERE 1=1 ${hasFilter ? 'AND c.id = ANY($1)' : ''}
       GROUP BY c.id, c.name`,
      params
    );

    const colStats = cols.rows.map(c => `  ${c.id}: ${c.doc_count || 0} docs`).join('\n');

    return {
      content: [{
        type: 'text',
        text: `Archive Status:\n- Total chunks: ${chunks.rows[0].total}\n- Total documents: ${files.rows[0].total}\n- Active API keys: ${keys.rows[0].total}\n- Collections:\n${colStats}\n- Embedding: ${EMBEDDING_MODEL} (${EMBEDDING_DIMS}d, Vertex AI)`,
      }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ── Auth middleware (DB-backed, collection-scoped) ─────────────────────────────
async function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key']
    || req.headers['authorization']?.replace('Bearer ', '')
    || req.query['api-key'];

  if (!key) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const pool = await getDbPool();
    const result = await pool.query(
      `SELECT user_id, user_name, email, collection_ids FROM api_keys WHERE key = $1 AND is_active = TRUE`,
      [key]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Unauthorized' });

    const user = result.rows[0];
    const requestedCollection = req.params.collection || null;

    // Check collection access: null collection_ids = access to all
    if (requestedCollection && user.collection_ids && user.collection_ids.length > 0) {
      if (!user.collection_ids.includes(requestedCollection)) {
        return res.status(401).json({ error: 'Unauthorized — key not scoped to this collection' });
      }
    }

    req.user = user;
    req.apiKey = key;
    // Effective collections: requested specific one, or key's allowed ones, or all (null)
    req.collectionIds = requestedCollection
      ? [requestedCollection]
      : (user.collection_ids?.length ? user.collection_ids : null);

    next();
  } catch (err) {
    console.error('[auth] DB error, falling back to env var:', err.message);
    if (API_KEY && key === API_KEY) {
      req.user = { user_id: 'admin', user_name: 'Admin' };
      req.apiKey = key;
      req.collectionIds = req.params.collection ? [req.params.collection] : null;
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// ── MCP handler (shared by root and collection routes) ────────────────────────
async function handleMcpPost(req, res) {
  const sessionId = req.headers['mcp-session-id'] || randomUUID();
  const message = req.body;
  const collectionId = req.params.collection || null;

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
          serverInfo: { name: 'fac-mcp-server', version: '2.0.0' },
        },
      });
    }

    if (message.method === 'notifications/initialized') {
      return res.status(200).send();
    }

    if (message.method === 'tools/list') {
      let collection = null;
      if (collectionId) {
        const pool = await getDbPool();
        collection = await getCollection(pool, collectionId);
      }
      return res.json({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: buildTools(collection) },
      });
    }

    if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;
      const startTime = Date.now();
      console.log(`[tool] ${name} user=${req.user?.user_id} collection=${collectionId || 'all'}`);

      try {
        const result = await handleToolCall(name, args || {}, req.collectionIds);
        logUsage(req.apiKey, req.user?.user_id, name, args?.query, collectionId, Date.now() - startTime, true);
        return res.json({ jsonrpc: '2.0', id: message.id, result });
      } catch (toolErr) {
        logUsage(req.apiKey, req.user?.user_id, name, args?.query, collectionId, Date.now() - startTime, false);
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
}

function handleMcpSse(req, res) {
  const sessionId = req.headers['mcp-session-id'] || randomUUID();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('mcp-session-id', sessionId);
  res.flushHeaders();
  const ping = setInterval(() => res.write(': ping\n\n'), 30000);
  req.on('close', () => clearInterval(ping));
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

// ── Admin middleware ───────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.user?.user_id !== 'admin') {
    return res.status(403).json({ error: 'Forbidden — admin only' });
  }
  next();
}

// ── Admin routes ───────────────────────────────────────────────────────────────
app.get('/admin/stats', requireApiKey, requireAdmin, async (req, res) => {
  try {
    const pool = await getDbPool();
    const [chunks, docs, activeKeys, requests30d, daily, topUsers, byTool] = await Promise.all([
      pool.query('SELECT COUNT(*) as total FROM sermon_chunks'),
      pool.query('SELECT COUNT(DISTINCT filename) as total FROM sermon_chunks'),
      pool.query('SELECT COUNT(*) as total FROM api_keys WHERE is_active = TRUE'),
      pool.query(`SELECT COUNT(*) as total FROM usage_logs WHERE timestamp > NOW() - INTERVAL '30 days'`),
      pool.query(`
        SELECT TO_CHAR(DATE(timestamp), 'YYYY-MM-DD') as date, COUNT(*) as count
        FROM usage_logs WHERE timestamp > NOW() - INTERVAL '14 days'
        GROUP BY DATE(timestamp) ORDER BY date
      `),
      pool.query(`
        SELECT k.user_name, l.user_id, COUNT(*) as requests
        FROM usage_logs l
        LEFT JOIN api_keys k ON k.user_id = l.user_id
        WHERE l.timestamp > NOW() - INTERVAL '30 days'
        GROUP BY l.user_id, k.user_name ORDER BY requests DESC LIMIT 10
      `),
      pool.query(`
        SELECT tool_name, COUNT(*) as count
        FROM usage_logs WHERE timestamp > NOW() - INTERVAL '30 days'
        GROUP BY tool_name ORDER BY count DESC
      `),
    ]);
    res.json({
      totalChunks: Number(chunks.rows[0].total),
      totalDocs: Number(docs.rows[0].total),
      activeKeys: Number(activeKeys.rows[0].total),
      requestsLast30Days: Number(requests30d.rows[0].total),
      dailyCounts: daily.rows.map(r => ({ date: r.date, count: Number(r.count) })),
      topUsers: topUsers.rows.map(r => ({ userId: r.user_id, userName: r.user_name || r.user_id, requests: Number(r.requests) })),
      byTool: byTool.rows.map(r => ({ tool: r.tool_name, count: Number(r.count) })),
    });
  } catch (err) {
    console.error('[admin/stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/keys', requireApiKey, requireAdmin, async (req, res) => {
  try {
    const pool = await getDbPool();
    const result = await pool.query(`
      SELECT key, user_id, user_name, email, created_at, last_used_at,
             is_active, request_count, notes, collection_ids
      FROM api_keys ORDER BY created_at DESC
    `);
    res.json({ keys: result.rows });
  } catch (err) {
    console.error('[admin/keys]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/keys', requireApiKey, requireAdmin, async (req, res) => {
  const { user_id, user_name, email = '', notes = '', collection_ids = null } = req.body;
  if (!user_id || !user_name) {
    return res.status(400).json({ error: 'user_id and user_name are required' });
  }
  try {
    const key = 'fac_' + randomBytes(24).toString('hex');
    const pool = await getDbPool();
    await pool.query(
      `INSERT INTO api_keys (key, user_id, user_name, email, notes, collection_ids)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [key, user_id, user_name, email, notes, collection_ids || null]
    );
    res.json({ key, user_id, user_name, email, notes });
  } catch (err) {
    console.error('[admin/keys POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/keys/:keyId/revoke', requireApiKey, requireAdmin, async (req, res) => {
  try {
    const pool = await getDbPool();
    const result = await pool.query(
      `UPDATE api_keys SET is_active = FALSE WHERE key = $1 RETURNING user_id, user_name`,
      [req.params.keyId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Key not found' });
    res.json({ success: true, ...result.rows[0] });
  } catch (err) {
    console.error('[admin/keys revoke]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/keys/:keyId/activate', requireApiKey, requireAdmin, async (req, res) => {
  try {
    const pool = await getDbPool();
    const result = await pool.query(
      `UPDATE api_keys SET is_active = TRUE WHERE key = $1 RETURNING user_id, user_name`,
      [req.params.keyId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Key not found' });
    res.json({ success: true, ...result.rows[0] });
  } catch (err) {
    console.error('[admin/keys activate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Routes — root (all accessible collections) ────────────────────────────────
app.post('/mcp', requireApiKey, handleMcpPost);
app.get('/mcp', requireApiKey, handleMcpSse);
app.delete('/mcp', requireApiKey, (req, res) => res.status(204).send());

// ── Routes — collection-specific ──────────────────────────────────────────────
app.post('/:collection/mcp', requireApiKey, handleMcpPost);
app.get('/:collection/mcp', requireApiKey, handleMcpSse);
app.delete('/:collection/mcp', requireApiKey, (req, res) => res.status(204).send());

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`FAC MCP Server v2 running on port ${PORT}`);
  console.log(`Embedding: ${EMBEDDING_MODEL} via Vertex AI`);

  try {
    const pool = await getDbPool();
    await initSchema(pool);
    await migrateEnvKey(pool);
    console.log('[startup] Ready');
  } catch (err) {
    console.error('[startup] Failed:', err.message);
  }
});
