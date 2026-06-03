#!/usr/bin/env node
/**
 * FAC MCP Server — API Key Admin CLI
 *
 * Usage:
 *   node scripts/admin.mjs create <user_id> "<name>" "<email>" ["notes"]
 *   node scripts/admin.mjs list
 *   node scripts/admin.mjs usage <user_id> [limit]
 *   node scripts/admin.mjs revoke <key>
 *   node scripts/admin.mjs rotate <key>
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
const pool = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME || 'facsermons',
  user: process.env.DB_USER || 'facadmin',
  password: process.env.DB_PASSWORD,
  port: 5432,
  ssl: { rejectUnauthorized: false },
});

function generateKey() {
  return randomBytes(32).toString('hex');
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function cmdCreate(userId, userName, email, notes = '') {
  const key = generateKey();
  await pool.query(
    `INSERT INTO api_keys (key, user_id, user_name, email, notes) VALUES ($1, $2, $3, $4, $5)`,
    [key, userId, userName, email || '', notes]
  );
  console.log(`\n✅ Key created for ${userName}`);
  console.log(`   User ID:  ${userId}`);
  console.log(`   Key:      ${key}`);
  console.log(`\n   Claude Desktop x-api-key header: ${key}`);
  console.log(`   claude.ai URL param: ?api-key=${key}\n`);
}

async function cmdList() {
  const { rows } = await pool.query(
    `SELECT user_name, user_id, is_active, request_count, last_used_at, key, notes
     FROM api_keys ORDER BY created_at DESC`
  );
  if (rows.length === 0) { console.log('No keys found.'); return; }

  console.log(`\n${'Name'.padEnd(22)} ${'User ID'.padEnd(18)} ${'Active'.padEnd(8)} ${'Requests'.padEnd(10)} ${'Last Used'.padEnd(20)} Key`);
  console.log('─'.repeat(100));
  for (const r of rows) {
    const status = r.is_active ? '✅' : '❌';
    const lastUsed = r.last_used_at ? new Date(r.last_used_at).toLocaleString() : 'Never';
    console.log(`${r.user_name.padEnd(22)} ${r.user_id.padEnd(18)} ${status.padEnd(8)} ${String(r.request_count).padEnd(10)} ${lastUsed.padEnd(20)} ${r.key.slice(0, 16)}...`);
  }
  console.log();
}

async function cmdUsage(userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT tool_name, query, timestamp, response_time_ms, success
     FROM usage_logs WHERE user_id = $1
     ORDER BY timestamp DESC LIMIT $2`,
    [userId, parseInt(limit)]
  );
  if (rows.length === 0) { console.log(`No usage found for ${userId}.`); return; }

  console.log(`\nRecent activity for ${userId}:\n`);
  for (const r of rows) {
    const ts = new Date(r.timestamp).toLocaleString();
    const status = r.success ? '✅' : '❌';
    const query = (r.query || '').slice(0, 60);
    console.log(`  ${status} ${ts}  ${r.tool_name?.padEnd(20)}  ${r.response_time_ms}ms  ${query}`);
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

async function cmdRename(userId, newName) {
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET user_name = $1 WHERE user_id = $2`, [newName, userId]
  );
  if (rowCount === 0) { console.log('User not found.'); return; }
  console.log(`✅ Renamed ${userId} to "${newName}"`);
}

async function cmdRotate(oldKey) {
  const { rows } = await pool.query(
    `SELECT user_id, user_name, email, notes FROM api_keys WHERE key = $1`, [oldKey]
  );
  if (rows.length === 0) { console.log('Key not found.'); return; }

  const { user_id, user_name, email, notes } = rows[0];
  await pool.query(`UPDATE api_keys SET is_active = FALSE WHERE key = $1`, [oldKey]);

  const newKey = generateKey();
  await pool.query(
    `INSERT INTO api_keys (key, user_id, user_name, email, notes) VALUES ($1, $2, $3, $4, $5)`,
    [newKey, user_id, user_name, email, `Rotated. Previous: ${notes}`]
  );
  console.log(`✅ Key rotated for ${user_name}`);
  console.log(`   New key: ${newKey}`);
}

async function cmdStats() {
  const { rows: keyStats } = await pool.query(
    `SELECT COUNT(*) as total, SUM(request_count) as total_requests FROM api_keys WHERE is_active = TRUE`
  );
  const { rows: recentLogs } = await pool.query(
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
  console.log('Tool usage:');
  for (const r of recentLogs) console.log(`  ${r.tool_name?.padEnd(25)} ${r.count}`);
  console.log('\nTop users:');
  for (const r of topUsers) console.log(`  ${r.user_id?.padEnd(25)} ${r.count} requests`);
  console.log();
}

// ── Main ───────────────────────────────────────────────────────────────────────
const [,, cmd, ...rest] = process.argv;

const commands = {
  create: () => cmdCreate(rest[0], rest[1], rest[2], rest[3]),
  list:   () => cmdList(),
  usage:  () => cmdUsage(rest[0], rest[1]),
  revoke: () => cmdRevoke(rest[0]),
  rotate: () => cmdRotate(rest[0]),
  rename: () => cmdRename(rest[0], rest[1]),
  stats:  () => cmdStats(),
};

if (!cmd || !commands[cmd]) {
  console.log(`
FAC MCP Admin

Commands:
  create <user_id> "<name>" "<email>" ["notes"]   Create a new API key
  list                                             List all keys and status
  usage <user_id> [limit]                          Show recent activity
  revoke <key>                                     Deactivate a key
  rotate <key>                                     Replace a key with a new one
  stats                                            Usage stats (last 7 days)

Examples:
  node scripts/admin.mjs create pastor_john "Pastor John" john@fac.com
  node scripts/admin.mjs list
  node scripts/admin.mjs usage pastor_john 50
  node scripts/admin.mjs stats
`);
  process.exit(0);
}

try {
  await commands[cmd]();
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
