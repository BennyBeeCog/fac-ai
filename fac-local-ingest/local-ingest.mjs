#!/usr/bin/env node
/**
 * Local sermon ingestion script
 * - Reads all .txt files from SERMON_DIR
 * - Truncates the sermon_chunks table
 * - Chunks each file, embeds via Bedrock Titan, inserts into pgvector
 * - Runs sequentially to avoid rate limits
 *
 * Usage:
 *   npm install pg @aws-sdk/client-bedrock-runtime
 *   node local-ingest.mjs
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import pg from 'pg';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const { Pool } = pg;

// ===== CONFIG =====
const SERMON_DIR = '/Users/benjaminpenton/Documents/BibleAITraining/fac_sermon_training';
const DB_HOST = 'localhost';
const DB_PORT = 5432;
const DB_NAME = 'facsermons';
const DB_USER = 'facadmin';
const DB_PASSWORD = 'wCGdzc4uBtugectZkth706UjeGiffK7O';
const AWS_REGION = 'us-east-1';
const BEDROCK_MODEL_ID = 'amazon.titan-embed-text-v2:0';

// Match Lambda chunking settings exactly
const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 100;

// Small delay between Bedrock calls to be safe
const EMBED_DELAY_MS = 100;

// ===== SETUP =====
const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const bedrock = new BedrockRuntimeClient({ region: AWS_REGION });

// ===== HELPERS =====
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + size));
    i += size - overlap;
  }
  return chunks;
}

async function embedText(text, maxRetries = 10) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await bedrock.send(new InvokeModelCommand({
        modelId: BEDROCK_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({ inputText: text }),
      }));
      const result = JSON.parse(Buffer.from(response.body).toString());
      return result.embedding;
    } catch (err) {
      const isRateLimit = err.message?.includes('Too many requests') || err.name === 'ThrottlingException';
      if (isRateLimit && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        console.log(`  [Bedrock] Rate limited, retry ${attempt + 1}/${maxRetries - 1} in ${Math.round(delay)}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ===== MAIN =====
async function main() {
  console.log('Connecting to RDS...');
  const client = await pool.connect();
  try {
    console.log('Truncating sermon_chunks table...');
    await client.query('TRUNCATE sermon_chunks RESTART IDENTITY');
    console.log('Done. Reading sermon files...');
  } finally {
    client.release();
  }

  const allFiles = await readdir(SERMON_DIR);
  const txtFiles = allFiles.filter(f => f.endsWith('.txt'));
  console.log(`Found ${txtFiles.length} .txt files\n`);

  let totalChunks = 0;
  let successFiles = 0;
  let failedFiles = [];

  for (let fileIdx = 0; fileIdx < txtFiles.length; fileIdx++) {
    const filename = txtFiles[fileIdx];
    const fileKey = `sermons/${filename}`;
    const filepath = join(SERMON_DIR, filename);

    try {
      const text = await readFile(filepath, 'utf8');
      const chunks = chunkText(text);
      console.log(`[${fileIdx + 1}/${txtFiles.length}] ${filename}`);
      console.log(`  ${text.length} chars → ${chunks.length} chunks`);

      const client = await pool.connect();
      try {
        for (let i = 0; i < chunks.length; i++) {
          const embedding = await embedText(chunks[i]);
          await client.query(
            `INSERT INTO sermon_chunks (file_key, filename, chunk_index, content, embedding)
             VALUES ($1, $2, $3, $4, $5)`,
            [fileKey, filename, i, chunks[i], JSON.stringify(embedding)]
          );
          if ((i + 1) % 10 === 0 || i === chunks.length - 1) {
            console.log(`  Embedded ${i + 1}/${chunks.length}`);
          }
          await sleep(EMBED_DELAY_MS);
        }
      } finally {
        client.release();
      }

      totalChunks += chunks.length;
      successFiles += 1;
      console.log(`  ✓ Done\n`);
    } catch (err) {
      console.error(`  ✗ FAILED: ${err.message}\n`);
      failedFiles.push({ filename, error: err.message });
    }
  }

  console.log('===== SUMMARY =====');
  console.log(`Files ingested: ${successFiles}/${txtFiles.length}`);
  console.log(`Total chunks: ${totalChunks}`);
  if (failedFiles.length > 0) {
    console.log(`\nFailed files:`);
    failedFiles.forEach(f => console.log(`  - ${f.filename}: ${f.error}`));
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
