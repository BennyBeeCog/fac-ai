#!/usr/bin/env node
/**
 * FAC MCP Admin CLI
 *
 * Usage:
 *   node scripts/admin.mjs create <user_id> "<name>" ["<email>"] ["notes"] [--collection col1,col2]
 *   node scripts/admin.mjs list
 *   node scripts/admin.mjs usage <user_id> [limit]
 *   node scripts/admin.mjs revoke <key>
 *   node scripts/admin.mjs rotate <key>
 *   node scripts/admin.mjs rename <user_id> "<new name>"
 *   node scripts/admin.mjs stats
 *   node scripts/admin.mjs collection create <id> "<name>" "<description>"
 *   node scripts/admin.mjs collection list
 *   node scripts/admin.mjs collection update-tool <id> "<tool description>"
 */

import pg from 'pg';
import { randomBytes } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = path.join(__dirname, '../.env');
try {
  const envContent = await readFile(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const clean = line.replace(/#.*$/, '').trim();
    const match = clean.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) process.env[match[1]] ??= match[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}

const { Pool } = pg;
const isProxy = (process.env.DB_HOST || '127.0.0.1') === '127.0.0.1';
const pool = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME || 'facsermons',
  user: process.env.DB_USER || 'facadmin',
  password: process.env.DB_PASSWORD,
  port: 5432,
  ssl: isProxy ? false : { rejectUnauthorized: false },
});

function generateKey() {
  return randomBytes(32).toString('hex');
}

function parseArgs() {
  const args = process.argv.slice(2);
  const collectionFlag = args.findIndex(a => a === '--collection');
  let collections = null;
  if (collectionFlag !== -1) {
    collections = args[collectionFlag + 1]?.split(',').map(s => s.trim()).filter(Boolean);
    args.splice(collectionFlag, 2);
  }
  return { args, collections };
}

// ── Key commands ───────────────────────────────────────────────────────────────

async function cmdCreate(userId, userName, email, notes, collectionIds) {
  const key = generateKey();
  await pool.query(
    `INSERT INTO api_keys (key, user_id, user_name, email, notes, collection_ids) VALUES ($1, $2, $3, $4, $5, $6)`,
    [key, userId, userName, email || '', notes || '', collectionIds || null]
  );
  const scope = collectionIds?.length ? collectionIds.join(', ') : 'all collections';
  console.log(`\n✅ Key created for ${userName}`);
  console.log(`   User ID:    ${userId}`);
  console.log(`   Scope:      ${scope}`);
  console.log(`   Key:        ${key}`);

  if (collectionIds?.length === 1) {
    console.log(`\n   Claude Desktop: x-api-key: ${key}`);
    console.log(`   claude.ai URL:  https://mcp.facmcp.com/${collectionIds[0]}/mcp?api-key=${key}`);
  } else {
    console.log(`\n   claude.ai URL (all): https://mcp.facmcp.com/mcp?api-key=${key}`);
    if (collectionIds?.length) {
      collectionIds.forEach(c => {
        console.log(`   claude.ai URL (${c}): https://mcp.facmcp.com/${c}/mcp?api-key=${key}`);
      });
    }
  }
  console.log();
}

async function cmdList() {
  const { rows } = await pool.query(
    `SELECT user_name, user_id, is_active, request_count, last_used_at, key, notes, collection_ids
     FROM api_keys WHERE is_active = TRUE ORDER BY created_at DESC`
  );
  if (rows.length === 0) { console.log('No keys found.'); return; }

  console.log(`\n${'Name'.padEnd(25)} ${'User ID'.padEnd(18)} ${'Active'.padEnd(8)} ${'Requests'.padEnd(10)} ${'Collections'.padEnd(20)} ${'Last Used'.padEnd(20)} Key`);
  console.log('─'.repeat(130));
  for (const r of rows) {
    const status = r.is_active ? '✅' : '❌';
    const scope = r.collection_ids?.length ? r.collection_ids.join(', ') : 'all';
    const lastUsed = r.last_used_at ? r.last_used_at.toISOString().slice(0, 19).replace('T', ' ') : 'never';
    console.log(`${r.user_name.padEnd(25)} ${r.user_id.padEnd(18)} ${status.padEnd(8)} ${String(r.request_count).padEnd(10)} ${scope.padEnd(20)} ${lastUsed.padEnd(20)} ${r.key.slice(0, 16)}...`);
  }
  console.log();
}

async function cmdUsage(userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT tool_name, query, collection_id, timestamp, response_time_ms, success
     FROM usage_logs WHERE user_id = $1
     ORDER BY timestamp DESC LIMIT $2`,
    [userId, parseInt(limit)]
  );
  if (rows.length === 0) { console.log(`No usage found for ${userId}.`); return; }

  console.log(`\nRecent activity for ${userId}:\n`);
  for (const r of rows) {
    const ts = new Date(r.timestamp).toLocaleString();
    const status = r.success ? '✅' : '❌';
    const col = r.collection_id ? `[${r.collection_id}]` : '';
    console.log(`  ${status} ${ts}  ${r.tool_name?.padEnd(20)} ${col.padEnd(15)} ${(r.query || '').slice(0, 50)}`);
  }
  console.log();
}

async function cmdRevoke(key) {
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET is_active = FALSE WHERE key = $1`, [key]
  );
  if (rowCount === 0) { console.log('Key not found.'); return; }
  console.log(`✅ Key revoked: ${key.slice(0, 16)}...`);
}

async function cmdShowKey(userId) {
  const { rows } = await pool.query(
    `SELECT key FROM api_keys WHERE user_id = $1 AND is_active = TRUE`, [userId]
  );
  if (rows.length === 0) { console.log('No active key found for that user.'); return; }
  console.log(`\n   Key: ${rows[0].key}\n`);
}

async function cmdRevokeUser(userId) {
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET is_active = FALSE WHERE user_id = $1 AND is_active = TRUE`, [userId]
  );
  if (rowCount === 0) { console.log('No active keys found for that user.'); return; }
  console.log(`✅ Revoked ${rowCount} key(s) for user: ${userId}`);
}

async function cmdRotate(oldKey, newCollections) {
  const { rows } = await pool.query(
    `SELECT user_id, user_name, email, notes, collection_ids FROM api_keys WHERE key = $1`, [oldKey]
  );
  if (rows.length === 0) { console.log('Key not found.'); return; }

  const { user_id, user_name, email, notes, collection_ids } = rows[0];
  await pool.query(`UPDATE api_keys SET is_active = FALSE WHERE key = $1`, [oldKey]);

  const newKey = generateKey();
  const collections = newCollections || collection_ids;
  await pool.query(
    `INSERT INTO api_keys (key, user_id, user_name, email, notes, collection_ids) VALUES ($1, $2, $3, $4, $5, $6)`,
    [newKey, user_id, user_name, email, `Rotated. ${notes}`, collections]
  );
  console.log(`✅ Key rotated for ${user_name}`);
  console.log(`   New key: ${newKey}`);
}

async function cmdRename(userId, newName) {
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET user_name = $1 WHERE user_id = $2`, [newName, userId]
  );
  if (rowCount === 0) { console.log('User not found.'); return; }
  console.log(`✅ Renamed ${userId} to "${newName}"`);
}

async function cmdSetId(oldUserId, newUserId) {
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET user_id = $1 WHERE user_id = $2`, [newUserId, oldUserId]
  );
  if (rowCount === 0) { console.log('User not found.'); return; }
  await pool.query(`UPDATE usage_logs SET user_id = $1 WHERE user_id = $2`, [newUserId, oldUserId]);
  console.log(`✅ Updated user ID: ${oldUserId} → ${newUserId}`);
}

async function cmdStats() {
  const { rows: keyStats } = await pool.query(
    `SELECT COUNT(*) as total, SUM(request_count) as total_requests FROM api_keys WHERE is_active = TRUE`
  );
  const { rows: colStats } = await pool.query(
    `SELECT collection_id, COUNT(*) as requests FROM usage_logs
     WHERE timestamp > NOW() - INTERVAL '7 days'
     GROUP BY collection_id ORDER BY requests DESC`
  );
  const { rows: toolStats } = await pool.query(
    `SELECT tool_name, COUNT(*) as count FROM usage_logs
     WHERE timestamp > NOW() - INTERVAL '7 days'
     GROUP BY tool_name ORDER BY count DESC`
  );
  const { rows: topUsers } = await pool.query(
    `SELECT user_id, COUNT(*) as count FROM usage_logs
     WHERE timestamp > NOW() - INTERVAL '7 days'
     GROUP BY user_id ORDER BY count DESC LIMIT 10`
  );

  console.log(`\n📊 Stats (last 7 days)\n`);
  console.log(`Active keys: ${keyStats[0].total}   Total requests ever: ${keyStats[0].total_requests || 0}\n`);
  if (colStats.length) {
    console.log('By collection:');
    colStats.forEach(r => console.log(`  ${(r.collection_id || 'root').padEnd(20)} ${r.requests} requests`));
  }
  console.log('\nBy tool:');
  toolStats.forEach(r => console.log(`  ${r.tool_name?.padEnd(25)} ${r.count}`));
  console.log('\nTop users:');
  topUsers.forEach(r => console.log(`  ${r.user_id?.padEnd(25)} ${r.count} requests`));
  console.log();
}

// ── Collection commands ────────────────────────────────────────────────────────

async function cmdCollectionCreate(id, name, description) {
  await pool.query(
    `INSERT INTO collections (id, name, description) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = $2, description = $3`,
    [id, name, description || '']
  );
  console.log(`✅ Collection created: ${id}`);
  console.log(`   Name: ${name}`);
  console.log(`   Ingest URL:   LOCAL_SERMON_DIR=<dir> COLLECTION_ID=${id} ./scripts/ingest-local.sh`);
  console.log(`   MCP endpoint: https://mcp.facmcp.com/${id}/mcp`);
}

async function cmdCollectionList() {
  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.description, COUNT(DISTINCT sc.filename) as doc_count, COUNT(sc.id) as chunk_count
    FROM collections c
    LEFT JOIN sermon_chunks sc ON sc.collection_id = c.id
    GROUP BY c.id, c.name, c.description
    ORDER BY c.id
  `);
  if (rows.length === 0) { console.log('No collections.'); return; }

  console.log(`\n${'ID'.padEnd(20)} ${'Name'.padEnd(30)} ${'Docs'.padEnd(8)} Chunks`);
  console.log('─'.repeat(75));
  for (const r of rows) {
    console.log(`${r.id.padEnd(20)} ${r.name.padEnd(30)} ${String(r.doc_count).padEnd(8)} ${r.chunk_count}`);
  }
  console.log();
}

async function cmdCollectionUpdateTool(id, toolDescription) {
  const { rowCount } = await pool.query(
    `UPDATE collections SET tool_description = $1 WHERE id = $2`, [toolDescription, id]
  );
  if (rowCount === 0) { console.log('Collection not found.'); return; }
  console.log(`✅ Updated tool description for: ${id}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────
const { args, collections } = parseArgs();
const [cmd, ...rest] = args;

try {
  if (cmd === 'collection') {
    const [subCmd, ...subRest] = rest;
    if (subCmd === 'create') await cmdCollectionCreate(subRest[0], subRest[1], subRest[2]);
    else if (subCmd === 'list') await cmdCollectionList();
    else if (subCmd === 'update-tool') await cmdCollectionUpdateTool(subRest[0], subRest[1]);
    else console.log('Unknown collection command. Use: create, list, update-tool');
  } else if (cmd === 'create') {
    await cmdCreate(rest[0], rest[1], rest[2], rest[3], collections);
  } else if (cmd === 'list') {
    await cmdList();
  } else if (cmd === 'usage') {
    await cmdUsage(rest[0], rest[1]);
  } else if (cmd === 'revoke') {
    await cmdRevoke(rest[0]);
  } else if (cmd === 'show-key') {
    await cmdShowKey(rest[0]);
  } else if (cmd === 'revoke-user') {
    await cmdRevokeUser(rest[0]);
  } else if (cmd === 'rotate') {
    await cmdRotate(rest[0], collections);
  } else if (cmd === 'rename') {
    await cmdRename(rest[0], rest[1]);
  } else if (cmd === 'set-id') {
    await cmdSetId(rest[0], rest[1]);
  } else if (cmd === 'stats') {
    await cmdStats();
  } else {
    console.log(`
FAC MCP Admin

Key commands:
  create <user_id> "<name>" ["<email>"] ["notes"] [--collection col1,col2]
  list
  usage <user_id> [limit]
  revoke <key>
  rotate <key> [--collection col1,col2]
  rename <user_id> "<new name>"
  stats

Collection commands:
  collection create <id> "<name>" "<description>"
  collection list
  collection update-tool <id> "<tool description>"

Examples:
  node scripts/admin.mjs create pastor_john "Pastor John" "" "" --collection fac-sermons
  node scripts/admin.mjs create admin "Admin" --collection fac-sermons,woodward-docs
  node scripts/admin.mjs collection create woodward-docs "Woodward Docs" "Raymond Woodward sermons and articles"
  node scripts/admin.mjs collection list
`);
  }
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
