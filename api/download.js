// Video downloader backend for the page in this repo.
//
// POST /api/download  {url}            -> resolves a post link into downloadable files
// GET  /api/download?file=..&name=..   -> streams one of those files back as an attachment,
//                                         so the browser saves it instead of playing it.
// (MP3 and enlarged copies are made by api/convert.js.)

import { Readable } from 'node:stream';
import { UserError, allowedMedia, mediaHeaders, resolve, addSizes, ytJob, ytSearch, tiktokFeed, ytRelated } from '../lib/resolve.js';

export const config = { maxDuration: 60 };

const attachment = name => "attachment; filename=\"" + name.replace(/[^\x20-\x7e]|"/g, '_') + "\"; filename*=UTF-8''" + encodeURIComponent(name);

async function stream(req, res) {
  const file = String(req.query.file || '');
  if (!allowedMedia(file)) { res.status(400).json({ error: 'link.invalid' }); return; }
  // Older links for MP3 / enlarged copies: those now live in api/convert.js.
  if (req.query.audio || req.query.scale) {
    res.statusCode = 307;
    res.setHeader('Location', '/api/convert?' + new URLSearchParams(req.query).toString());
    res.end();
    return;
  }
  // Pass a Range request through, so a paused download can continue where it stopped.
  const h = mediaHeaders(file);
  const range = req.headers && req.headers.range;
  if (range && /^bytes=\d+-\d*$/.test(range)) h.Range = range;
  const up = await fetch(file, { headers: h });
  if (!up.ok || !up.body) { res.status(502).json({ error: 'fetch.fail' }); return; }
  const name = String(req.query.name || 'video.mp4');
  res.statusCode = up.status === 206 ? 206 : 200;
  res.setHeader('Content-Type', up.headers.get('content-type') || 'application/octet-stream');
  const len = up.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  const cr = up.headers.get('content-range');
  if (cr && up.status === 206) res.setHeader('Content-Range', cr);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', attachment(name));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  Readable.fromWeb(up.body).pipe(res);
}

export default async function handler(req, res) {
  // Public, read-only API: any page (GitHub Pages, the installed app) may call it.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    if (req.method === 'GET' && req.query && req.query.file) return await stream(req, res);
    if (req.method === 'GET' && req.query && req.query.tt !== undefined) {
      const out = await tiktokFeed(req.query.tt, req.query.cursor);
      res.setHeader('Cache-Control', 'public, s-maxage=120');   // the trending list changes; keep it fresh
      res.status(200).json(out); return;
    }
    if (req.method === 'GET' && req.query && req.query.related) {
      const out = await ytRelated(req.query.related, req.query.q);
      res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');
      res.status(200).json(out); return;
    }
    if (req.method === 'GET' && req.query && req.query.search) {
      const out = await ytSearch(req.query.search, req.query.sort, req.query.cont);
      res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');   // the same lists are asked for often
      res.status(200).json(out); return;
    }
    if (req.method === 'GET' && req.query && req.query.yt) { res.status(200).json(await ytJob(req.query)); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
    const url = String((req.body && req.body.url) || '').trim();
    const m = url.match(/https?:\/\/\S+/);
    if (!m) { res.status(400).json({ error: 'link.invalid' }); return; }
    const out = await resolve(m[0]);
    if (!out.items.length) throw new UserError('empty');
    await addSizes(out.items);
    res.status(200).json(out);
  } catch (e) {
    if (e instanceof UserError) { res.status(422).json({ error: e.code, detail: e.detail }); return; }
    console.error('download error', e);
    res.status(502).json({ error: 'fetch.fail', detail: String(e && e.message || e).slice(0, 80) });
  }
}
