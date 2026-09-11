#!/usr/bin/env node
/**
 * Scrapes PDFs from Raymond Woodward's website, extracts text,
 * and saves as .txt files ready for ingestion.
 *
 * Usage:
 *   node scripts/scrape-pdfs.mjs
 *   node scripts/scrape-pdfs.mjs --force   # re-download already saved files
 */

import { writeFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseHtml } from 'node-html-parser';
import dotenv from 'dotenv';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile as writeFileTmp, unlink } from 'fs/promises';
import { tmpdir } from 'os';
const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const OUTPUT_DIR = process.env.WOODWARD_SERMON_DIR
  || path.join(__dirname, '../../woodward-docs');
const FORCE = process.argv.includes('--force');

const PAGES = [
  'http://www.raymondwoodward.com/sermon-series.html',
  'http://www.raymondwoodward.com/bible-studies.html',
  'http://www.raymondwoodward.com/articles.html',
];

const BASE_URL = 'http://www.raymondwoodward.com';

// ── Find all PDF links on a page ───────────────────────────────────────────────
async function findPdfLinks(pageUrl) {
  const res = await fetch(pageUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`Failed to fetch ${pageUrl}: ${res.status}`);
  const html = await res.text();
  const root = parseHtml(html);

  const links = root.querySelectorAll('a[href]')
    .map(a => a.getAttribute('href'))
    .filter(href => href && href.toLowerCase().endsWith('.pdf'))
    .map(href => href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`);

  return [...new Set(links)]; // deduplicate
}

// ── Download and extract text from a PDF via pdftotext ────────────────────────
async function extractPdfText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Failed to download PDF: ${res.status}`);
  const tmpFile = path.join(tmpdir(), `pdf_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
  try {
    await writeFileTmp(tmpFile, Buffer.from(await res.arrayBuffer()));
    const { stdout } = await execFileAsync('pdftotext', [tmpFile, '-']);
    return stdout.trim();
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

// ── Derive a clean filename from a PDF URL ─────────────────────────────────────
function urlToFilename(url) {
  const raw = path.basename(new URL(url).pathname, '.pdf');
  const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
  return `woodward_${clean}.en.sermon.txt`;
}

// ── Check if already saved ─────────────────────────────────────────────────────
async function alreadySaved(filename) {
  if (FORCE) return false;
  return existsSync(path.join(OUTPUT_DIR, filename));
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Raymond Woodward PDF scraper`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  if (!existsSync(OUTPUT_DIR)) await mkdir(OUTPUT_DIR, { recursive: true });

  // Collect all PDF links across all pages
  const allLinks = new Set();
  for (const pageUrl of PAGES) {
    console.log(`Scanning: ${pageUrl}`);
    try {
      const links = await findPdfLinks(pageUrl);
      links.forEach(l => allLinks.add(l));
      console.log(`  Found ${links.length} PDFs\n`);
    } catch (err) {
      console.error(`  Failed: ${err.message}\n`);
    }
  }

  const links = [...allLinks];
  console.log(`Total unique PDFs found: ${links.length}\n`);

  let saved = 0;
  let skipped = 0;
  let failed = 0;

  for (const [i, url] of links.entries()) {
    const filename = urlToFilename(url);
    const pos = `[${i + 1}/${links.length}]`;

    if (await alreadySaved(filename)) {
      console.log(`${pos} Skipping — already saved: ${filename}`);
      skipped++;
      continue;
    }

    console.log(`${pos} Downloading: ${path.basename(url)}`);
    try {
      const text = await extractPdfText(url);
      if (!text || text.length < 100) {
        console.log(`  Skipping — no readable text extracted\n`);
        failed++;
        continue;
      }

      const content = [
        `Title: ${path.basename(url, '.pdf').replace(/_/g, ' ')}`,
        `Source: ${url}`,
        `Author: Raymond Woodward`,
        `---`,
        text,
      ].join('\n');

      await writeFile(path.join(OUTPUT_DIR, filename), content, 'utf-8');
      console.log(`  Saved: ${filename} (${text.length} chars)\n`);
      saved++;

      await new Promise(r => setTimeout(r, 500)); // be polite
    } catch (err) {
      console.error(`  Failed: ${err.message}\n`);
      failed++;
    }
  }

  console.log(`\n=== DONE ===`);
  console.log(`Saved: ${saved} | Skipped: ${skipped} | Failed: ${failed}`);
  console.log(`\nNext: run ingestion to embed these into the database`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
