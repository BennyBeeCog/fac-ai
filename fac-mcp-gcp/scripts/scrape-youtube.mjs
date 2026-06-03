#!/usr/bin/env node
/**
 * Scrapes all completed FAC Maryville YouTube livestreams,
 * extracts sermon content via Claude, and saves as .txt files
 * ready for ingest-local.sh.
 *
 * Usage:
 *   node scripts/scrape-youtube.mjs
 *   node scripts/scrape-youtube.mjs --backfill   # fetch all history
 */

import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const YOUTUBE_API_KEY = process.env.YT_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CHANNEL_ID = 'UCHp62H_qn8wC8jb2qJlxEDA';
const OUTPUT_DIR = process.env.LOCAL_SERMON_DIR || '/Users/benjaminpenton/Documents/BibleAITraining/fac_sermon_training';
const BACKFILL = process.argv.includes('--backfill');

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const BLOCKLIST_FILE = path.join(__dirname, '../blocked-videos.txt');
async function loadBlocklist() {
  try {
    const content = await readFile(BLOCKLIST_FILE, 'utf-8');
    return new Set(
      content.split('\n')
        .map(l => l.replace(/#.*$/, '').trim())  // strip inline comments
        .filter(l => l)
    );
  } catch {
    return new Set();
  }
}

// ── Fetch completed livestreams from YouTube API ───────────────────────────────
async function fetchLivestreams() {
  const allItems = [];
  let pageToken = null;

  do {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('channelId', CHANNEL_ID);
    url.searchParams.set('type', 'video');
    url.searchParams.set('eventType', 'completed');
    url.searchParams.set('maxResults', '50');
    url.searchParams.set('order', 'date');
    url.searchParams.set('key', YOUTUBE_API_KEY);

    if (!BACKFILL) {
      const eightDaysAgo = new Date();
      eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
      url.searchParams.set('publishedAfter', eightDaysAgo.toISOString());
    }

    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`YouTube API error: ${await res.text()}`);
    const data = await res.json();
    allItems.push(...(data.items || []));
    pageToken = data.nextPageToken || null;
    console.log(`Fetched ${allItems.length} videos so far...`);
    if (pageToken) await new Promise(r => setTimeout(r, 500));
  } while (pageToken && BACKFILL);

  return allItems;
}

// ── Download transcript via YouTube caption API ────────────────────────────────
async function fetchTranscriptNative(videoId) {
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    const html = await pageRes.text();
    const captionMatch = html.match(/"captionTracks":\s*(\[.*?\])/s);
    if (!captionMatch) return null;

    const tracks = JSON.parse(captionMatch[1].replace(/\\u0026/g, '&'));
    const track = tracks.find(t => t.languageCode === 'en' && t.kind === 'asr')
      || tracks.find(t => t.languageCode === 'en')
      || tracks[0];

    if (!track?.baseUrl) return null;

    const captionRes = await fetch(track.baseUrl + '&fmt=json3');
    const captionData = await captionRes.json();
    if (!captionData?.events) return null;

    const lines = captionData.events
      .filter(e => e.segs)
      .map(e => e.segs.map(s => s.utf8 || '').join('').trim())
      .filter(line => line.length > 0 && line !== '\n');

    const deduped = lines.filter((line, i) => i === 0 || line !== lines[i - 1]);
    const transcript = deduped.join('\n');
    return transcript.length > 100 ? transcript : null;
  } catch (err) {
    return null;
  }
}

// ── Download transcript via yt-dlp (fallback) ─────────────────────────────────
async function fetchTranscriptYtDlp(videoId) {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const { mkdtemp, readdir: rd, readFile: rf, rm } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const execFileAsync = promisify(execFile);

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'yt-dlp-'));
  try {
    await execFileAsync('yt-dlp', [
      '--write-auto-sub', '--write-sub',
      '--sub-lang', 'en',
      '--sub-format', 'vtt',
      '--skip-download',
      '--output', path.join(tmpDir, '%(id)s.%(ext)s'),
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
    const files = await rd(tmpDir);
    const vttFile = files.find(f => f.endsWith('.vtt'));
    if (!vttFile) return null;
    const vtt = await rf(path.join(tmpDir, vttFile), 'utf-8');
    const lines = vtt.split('\n')
      .filter(l => l && !l.startsWith('WEBVTT') && !l.startsWith('NOTE') && !/^\d{2}:\d{2}/.test(l))
      .map(l => l.replace(/<[^>]+>/g, '').trim())
      .filter(l => l.length > 0);
    const deduped = lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
    const transcript = deduped.join('\n');
    return transcript.length > 100 ? transcript : null;
  } catch (err) {
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ── Transcribe audio via local Whisper ─────────────────────────────────────────
async function fetchTranscriptWhisper(videoId, title) {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const { mkdtemp, readdir: rd, readFile: rf, rm } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const execFileAsync = promisify(execFile);

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'whisper-'));
  try {
    console.log(`  Downloading audio for Whisper (this may take a while for long videos)...`);
    await new Promise(r => setTimeout(r, 3000)); // avoid rate limiting
    const skipMinutes = parseInt(process.env.SKIP_MINUTES || '15');
    await execFileAsync('yt-dlp', [
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
      '--cookies', path.join(__dirname, '../youtube-cookies.txt'),
      '--download-sections', `*${skipMinutes * 60}-inf`,
      '--output', path.join(tmpDir, '%(id)s.%(ext)s'),
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { timeout: 10800000 }); // 3 hour download timeout

    const files = await rd(tmpDir);
    const audioFile = (await rd(tmpDir)).find(f => /\.(m4a|mp3|webm|ogg|opus|weba)$/.test(f));
    if (!audioFile) {
      console.log(`  No audio file downloaded`);
      return null;
    }

    const whisperModel = process.env.WHISPER_MODEL || 'tiny';
    console.log(`  Running Whisper transcription (${whisperModel} model)...`);
    await execFileAsync('whisper', [
      path.join(tmpDir, audioFile),
      '--model', whisperModel,
      '--task', 'translate',
      '--output_format', 'txt',
      '--output_dir', tmpDir,
      '--verbose', 'True',
    ], { timeout: 7200000 }); // 2 hour transcription timeout (covers 3hr services)

    const txtFile = files.find(f => f.endsWith('.txt')) ||
      (await rd(tmpDir)).find(f => f.endsWith('.txt'));
    if (!txtFile) return null;

    const transcript = await rf(path.join(tmpDir, txtFile), 'utf-8');
    return transcript.length > 100 ? transcript : null;
  } catch (err) {
    console.error(`  Whisper failed: ${err.message}`);
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ── Try native → yt-dlp → Whisper ─────────────────────────────────────────────
async function fetchTranscript(videoId, title) {
  const native = await fetchTranscriptNative(videoId);
  if (native) return native;

  console.log(`  Native captions not found — trying yt-dlp...`);
  const ytdlp = await fetchTranscriptYtDlp(videoId);
  if (ytdlp) {
    console.log(`  yt-dlp found transcript`);
    return ytdlp;
  }

  console.log(`  No captions found — using Whisper...`);
  return fetchTranscriptWhisper(videoId, title);
}

// ── Filter transcript to sermon content via Claude ─────────────────────────────
async function extractSermonContent(transcript, title) {
  const MAX_CHUNK = 80000;
  const chunks = [];
  for (let i = 0; i < transcript.length; i += MAX_CHUNK) {
    chunks.push(transcript.slice(i, i + MAX_CHUNK));
  }

  const filteredChunks = [];
  for (const chunk of chunks) {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: `You are a transcript processor for FAC Maryville church. Your job is to extract sermon content from the following transcript excerpt of "${title}". Work only with what is provided — do not ask for more content.\n\nREMOVE: song lyrics, worship music, offering instructions, technical announcements, filler phrases.\nKEEP: pastoral teaching, scripture references, theological points, illustrations, altar call messages, prayers that contain teaching.\n\nIf this excerpt contains only pre-service content with no teaching yet, return the word SKIP.\nOtherwise return ONLY the extracted teaching text.\n\nTRANSCRIPT:\n${chunk}`
      }]
    });

    const filtered = response.content[0].text.trim();
    if (filtered && filtered !== 'SKIP') filteredChunks.push(filtered);
  }

  return filteredChunks.length > 0 ? filteredChunks.join('\n\n') : null;
}

// ── Check if video already scraped ────────────────────────────────────────────
async function alreadyScraped(videoId) {
  if (!existsSync(OUTPUT_DIR)) return false;
  const files = await readdir(OUTPUT_DIR);
  return files.some(f => f.includes(videoId));
}

// ── Save sermon to .txt file ───────────────────────────────────────────────────
async function saveSermon(videoId, title, publishedAt, content) {
  const date = new Date(publishedAt).toISOString().split('T')[0];
  const sanitizedTitle = title.replace(/[^a-zA-Z0-9\s-]/g, '').trim().replace(/\s+/g, '_').slice(0, 80);
  const filename = `${date}_${sanitizedTitle}_${videoId}.en.sermon.txt`;
  const fullContent = [
    `Title: ${title}`,
    `Video ID: ${videoId}`,
    `Published: ${publishedAt}`,
    `URL: https://www.youtube.com/watch?v=${videoId}`,
    `Channel: FAC Maryville (@FACMaryville)`,
    `---`,
    content,
  ].join('\n');

  await writeFile(path.join(OUTPUT_DIR, filename), fullContent, 'utf-8');
  return filename;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  if (!YOUTUBE_API_KEY) throw new Error('YT_API_KEY not set in .env');
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set in .env');

  console.log(`FAC YouTube scraper — mode: ${BACKFILL ? 'BACKFILL (all history)' : 'recent (last 8 days)'}`);
  console.log(`Output dir: ${OUTPUT_DIR}\n`);

  if (!existsSync(OUTPUT_DIR)) await mkdir(OUTPUT_DIR, { recursive: true });

  const videos = await fetchLivestreams();
  console.log(`\nFound ${videos.length} livestreams\n`);

  const blocklist = await loadBlocklist();
  if (blocklist.size > 0) console.log(`Blocklist loaded: ${blocklist.size} videos blocked\n`);

  const results = { found: videos.length, scraped: 0, skipped: 0, blocked: 0, failed: 0 };
  const failures = [];

  for (const [i, video] of videos.entries()) {
    const videoId = video.id.videoId;
    const title = video.snippet.title;
    const publishedAt = video.snippet.publishedAt;

    console.log(`[${i + 1}/${videos.length}] ${title}`);

    if (blocklist.has(videoId)) {
      console.log(`  Skipping — blocked\n`);
      results.blocked++;
      continue;
    }

    if (await alreadyScraped(videoId)) {
      console.log(`  Skipping — already scraped\n`);
      results.skipped++;
      continue;
    }

    const transcript = await fetchTranscript(videoId, title);
    if (!transcript) {
      console.log(`  No transcript available\n`);
      results.failed++;
      failures.push({ videoId, title, reason: 'no_transcript', url: `https://youtube.com/watch?v=${videoId}` });
      continue;
    }

    console.log(`  Transcript: ${transcript.length} chars — filtering with Claude...`);
    const sermonContent = await extractSermonContent(transcript, title);
    if (!sermonContent) {
      console.log(`  No sermon content found\n`);
      results.failed++;
      continue;
    }

    const filename = await saveSermon(videoId, title, publishedAt, sermonContent);
    console.log(`  Saved: ${filename}\n`);
    results.scraped++;

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('=== DONE ===');
  console.log(`Found: ${results.found} | Scraped: ${results.scraped} | Skipped: ${results.skipped} | Blocked: ${results.blocked} | Failed: ${results.failed}`);

  if (failures.length > 0) {
    const logPath = path.join(__dirname, '../failed-scrapes.json');
    await writeFile(logPath, JSON.stringify(failures, null, 2));
    console.log(`\nFailed videos logged to: failed-scrapes.json`);
    failures.forEach(f => console.log(`  [${f.reason}] ${f.title} — ${f.url}`));
  }

  console.log(`\nRun ingestion: ./scripts/ingest-local.sh`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
