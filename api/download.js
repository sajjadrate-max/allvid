// Video downloader backend for the page in this repo.
//
// POST /api/download  {url}            -> resolves a post link into downloadable files
// GET  /api/download?file=..&name=..   -> streams one of those files back as an attachment,
//                                         so the browser saves it instead of playing it.
// GET  ...&audio=1                     -> the same file's sound only, converted to MP3 by ffmpeg.
// GET  ...&scale=720|1080              -> the same video enlarged to that size (short side) by ffmpeg.

import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { UserError, allowedMedia, mediaHeaders, resolve, addSizes } from '../lib/resolve.js';

export const config = { maxDuration: 60 };

const attachment = name => "attachment; filename=\"" + name.replace(/[^\x20-\x7e]|"/g, '_') + "\"; filename*=UTF-8''" + encodeURIComponent(name);

// The API downloads the video to a temporary file (ffmpeg-static's own networking can
// crash on name lookups), then ffmpeg writes just its sound as MP3.
async function convert(req, res, file, scale) {
  let bin = process.env.FFMPEG_PATH;
  if (!bin) {
    try { bin = (await import('ffmpeg-static')).default; } catch { /* not installed */ }
  }
  if (!bin) { res.status(501).json({ error: 'convert.unavailable' }); return; }
  const up = await fetch(file, { headers: mediaHeaders(file) });
  if (!up.ok || !up.body) { res.status(502).json({ error: 'fetch.fail', detail: 'src:' + up.status }); return; }
  const tmp = join(tmpdir(), 'vdl-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.mp4');
  try {
    await pipeline(Readable.fromWeb(up.body), createWriteStream(tmp));
    const args = scale
      // Short side to `scale`, fast encode, fragmented MP4 so it can be streamed while it is made.
      ? ['-hide_banner', '-loglevel', 'error', '-i', tmp, '-vf', "scale='if(gt(iw,ih),-2," + scale + ")':'if(gt(iw,ih)," + scale + ",-2)':flags=lanczos",
         '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'copy',
         '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1']
      : ['-hide_banner', '-loglevel', 'error', '-i', tmp, '-vn', '-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', '160k', '-f', 'mp3', 'pipe:1'];
    const ff = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '', started = false;
    ff.stderr.on('data', d => { err += d; });
    ff.stdout.once('data', () => {
      started = true;
      const name = String(req.query.name || 'file').replace(/\.[a-z0-9]+$/i, '') + (scale ? ' ' + scale + 'p.mp4' : '.mp3');
      res.setHeader('Content-Type', scale ? 'video/mp4' : 'audio/mpeg');
      res.setHeader('Content-Disposition', attachment(name));
      res.setHeader('Cache-Control', 'private, max-age=3600');
    });
    ff.stdout.pipe(res, { end: false });
    await new Promise(done => ff.on('close', code => {
      if (started) res.end();
      else if (!res.headersSent) res.status(502).json({ error: scale ? 'scale.fail' : 'audio.fail', detail: String(code) + ' ' + err.slice(0, 120) });
      done();
    }));
  } finally {
    unlink(tmp).catch(() => {});
  }
}

async function stream(req, res) {
  const file = String(req.query.file || '');
  if (!allowedMedia(file)) { res.status(400).json({ error: 'link.invalid' }); return; }
  if (req.query.audio) return convert(req, res, file, 0);
  const scale = Number(req.query.scale);
  if (scale === 720 || scale === 1080) return convert(req, res, file, scale);
  const up = await fetch(file, { headers: mediaHeaders(file) });
  if (!up.ok || !up.body) { res.status(502).json({ error: 'fetch.fail' }); return; }
  const name = String(req.query.name || 'video.mp4');
  res.setHeader('Content-Type', up.headers.get('content-type') || 'application/octet-stream');
  const len = up.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  res.setHeader('Content-Disposition', attachment(name));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  Readable.fromWeb(up.body).pipe(res);
}

export default async function handler(req, res) {
  // Public, read-only API: any page (GitHub Pages, the installed app) may call it.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    if (req.method === 'GET' && req.query && req.query.file) return await stream(req, res);
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
