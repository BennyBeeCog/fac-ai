import pg from 'pg';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '../.env'), 'utf-8').split('\n')
    .map(l => l.replace(/#.*$/, '').trim()).filter(l => l)
    .map(l => l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)).filter(Boolean)
    .map(m => [m[1], m[2].replace(/^['"]|['"]$/g, '')])
);

const pool = new pg.Pool({
  host: env.DB_HOST,
  database: env.DB_NAME || 'facsermons',
  user: env.DB_USER || 'facadmin',
  password: env.DB_PASSWORD,
  port: 5432,
  ssl: { rejectUnauthorized: false },
});

const dir = env.LOCAL_SERMON_DIR;
const localFiles = new Set(readdirSync(dir).filter(f => f.endsWith('.txt')));

const { rows } = await pool.query(
  'SELECT DISTINCT file_key FROM sermon_chunks WHERE collection_id = $1',
  ['fac-sermons']
);

const stale = rows.filter(r => !localFiles.has(r.file_key));
console.log(`Local files: ${localFiles.size} | DB entries: ${rows.length} | Stale: ${stale.length}`);

if (stale.length > 0) {
  console.log('Stale keys:', stale.map(r => r.file_key).join('\n'));
  const keys = stale.map(r => r.file_key);
  const result = await pool.query('DELETE FROM sermon_chunks WHERE file_key = ANY($1)', [keys]);
  console.log(`Deleted ${result.rowCount} chunks`);
}

await pool.end();
