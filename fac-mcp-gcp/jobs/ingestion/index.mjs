import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { Storage } from '@google-cloud/storage';
import { Connector } from '@google-cloud/cloud-sql-connector';
import { GoogleAuth } from 'google-auth-library';
import pg from 'pg';

const { Pool } = pg;

const MODE = process.env.MODE || (process.env.GCS_BUCKET ? 'gcs' : 'local');
const GCS_BUCKET = process.env.GCS_BUCKET;
const GCS_PREFIX = process.env.GCS_PREFIX || 'sermons/';
const LOCAL_SERMON_DIR = process.env.LOCAL_SERMON_DIR || '/Users/benjaminpenton/Documents/BibleAITraining/fac_sermon_training';
const CLOUD_SQL_CONNECTION_NAME = process.env.CLOUD_SQL_CONNECTION_NAME;
const DB_HOST = process.env.DB_HOST;
const DB_NAME = process.env.DB_NAME || 'facsermons';
const DB_USER = process.env.DB_USER || 'facadmin';
const DB_PASSWORD = process.env.DB_PASSWORD;

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GCP_REGION = process.env.GCP_REGION || 'us-central1';
const COLLECTION_ID = process.env.COLLECTION_ID || 'fac-sermons';
const VERTEX_REGION = 'us-central1'; // text-embedding-005 not available in all regions
const EMBEDDING_MODEL = 'text-embedding-005';

const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 100;
const EMBED_DELAY_MS = 50;

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
      max: 5,
      idleTimeoutMillis: 30000,
    });
    console.log('[db] Connected via Cloud SQL connector:', CLOUD_SQL_CONNECTION_NAME);
  } else {
    const isProxy = (DB_HOST || '127.0.0.1') === '127.0.0.1';
    dbPool = new Pool({
      host: DB_HOST,
      database: DB_NAME,
      user: DB_USER,
      password: DB_PASSWORD,
      port: 5432,
      ssl: isProxy ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
    });
    console.log('[db] Connected via direct TCP:', DB_HOST);
  }

  return dbPool;
}

// ── Initialize schema ──────────────────────────────────────────────────────────
async function initSchema(pool) {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sermon_chunks (
      id SERIAL PRIMARY KEY,
      file_key TEXT NOT NULL,
      filename TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding vector(768),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS sermon_chunks_embedding_idx
    ON sermon_chunks USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS sermon_chunks_file_key_idx
    ON sermon_chunks (file_key)
  `);
  await pool.query(`ALTER TABLE sermon_chunks ADD COLUMN IF NOT EXISTS collection_id TEXT DEFAULT 'fac-sermons'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS sermon_chunks_collection_idx ON sermon_chunks (collection_id)`);
  console.log('[db] Schema ready');
}

// ── Chunk text ─────────────────────────────────────────────────────────────────
function chunkText(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 50) chunks.push(chunk);
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

// ── Embed via Vertex AI text-embedding-005 ─────────────────────────────────────
async function embedText(text, maxRetries = 5) {
  const client = await vertexAuth.getClient();
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/${VERTEX_REGION}/publishers/google/models/${EMBEDDING_MODEL}:predict`;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const token = await client.getAccessToken();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instances: [{ content: text }] }),
    });

    if (res.status === 429 && attempt < maxRetries - 1) {
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`[vertex] Rate limited, retry ${attempt + 1}/${maxRetries - 1} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    if (!res.ok) throw new Error(`Vertex AI embed failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.predictions[0].embeddings.values;
  }
}

// ── List sermon files ──────────────────────────────────────────────────────────
async function listFiles() {
  if (MODE === 'gcs') {
    const storage = new Storage();
    const [files] = await storage.bucket(GCS_BUCKET).getFiles({ prefix: GCS_PREFIX });
    return files
      .filter(f => f.name.endsWith('.txt'))
      .map(f => ({ key: f.name, filename: path.basename(f.name) }));
  } else {
    const entries = await readdir(LOCAL_SERMON_DIR);
    return entries
      .filter(f => f.endsWith('.txt'))
      .map(f => ({ key: f, filename: f }));
  }
}

// ── Read file content ──────────────────────────────────────────────────────────
async function readFileContent(fileKey) {
  if (MODE === 'gcs') {
    const storage = new Storage();
    const [contents] = await storage.bucket(GCS_BUCKET).file(fileKey).download();
    return contents.toString('utf-8');
  } else {
    return readFile(path.join(LOCAL_SERMON_DIR, fileKey), 'utf-8');
  }
}

// ── Ingest one file ────────────────────────────────────────────────────────────
async function ingestFile(pool, fileKey, filename) {
  const content = await readFileContent(fileKey);
  console.log(`[${filename}] Read ${content.length} chars`);

  const client = await pool.connect();
  try {
    await client.query('DELETE FROM sermon_chunks WHERE file_key = $1', [fileKey]);

    const chunks = chunkText(content);
    console.log(`[${filename}] ${chunks.length} chunks`);

    for (let i = 0; i < chunks.length; i++) {
      const embedding = await embedText(chunks[i]);
      await client.query(
        `INSERT INTO sermon_chunks (file_key, filename, chunk_index, content, embedding, collection_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [fileKey, filename, i, chunks[i], JSON.stringify(embedding), COLLECTION_ID]
      );

      if ((i + 1) % 10 === 0 || i === chunks.length - 1) {
        console.log(`[${filename}] ${i + 1}/${chunks.length} chunks embedded`);
      }

      await new Promise(r => setTimeout(r, EMBED_DELAY_MS));
    }

    console.log(`[${filename}] Done — ${chunks.length} chunks ingested`);
    return chunks.length;
  } finally {
    client.release();
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`FAC Ingestion Job starting — MODE=${MODE}, collection=${COLLECTION_ID}, embedding=${EMBEDDING_MODEL} via Vertex AI`);

  const pool = await getDbPool();
  await initSchema(pool);

  const files = await listFiles();
  console.log(`Found ${files.length} sermon files`);

  const FORCE = process.env.FORCE === 'true';
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  const total = files.length;

  for (const [i, { key, filename }] of files.entries()) {
    const pos = `[${i + 1}/${total}]`;
    try {
      if (!FORCE) {
        const existing = await pool.query(
          'SELECT 1 FROM sermon_chunks WHERE file_key = $1 AND collection_id = $2 LIMIT 1', [key, COLLECTION_ID]
        );
        if (existing.rows.length > 0) {
          console.log(`${pos} Skipping — already ingested: ${filename}`);
          skipped++;
          continue;
        }
      }
      await ingestFile(pool, key, filename);
      succeeded++;
      console.log(`${pos} ✓ Done (${succeeded} ingested, ${skipped} skipped, ${failed} failed)`);
    } catch (err) {
      console.error(`${pos} FAILED: ${filename} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\nIngestion complete: ${succeeded} ingested, ${skipped} skipped, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
