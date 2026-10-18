// MP3 and enlarged copies, made with ffmpeg. Kept apart from api/download.js so the
// ffmpeg binary (~70 MB) only loads here and finding links stays quick to start.
//
// GET /api/convert?file=..&name=..&audio=1         -> the file's sound as MP3
// GET /api/convert?file=..&name=..&scale=720|1080  -> the video enlarged to that size (short side)

import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { allowedMedia, mediaHeaders } from '../lib/resolve.js';

export const config = { maxDuration: 300 };

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    const file = String((req.query && req.query.file) || '');
    if (!allowedMedia(file)) { res.status(400).json({ error: 'link.invalid' }); return; }
    const scale = Number(req.query.scale);
    if (req.query.audio) return await convert(req, res, file, 0);
    if (scale === 720 || scale === 1080) return await convert(req, res, file, scale);
    res.status(400).json({ error: 'link.invalid' });
  } catch (e) {
    console.error('convert error', e);
    if (!res.headersSent) res.status(502).json({ error: 'fetch.fail', detail: String(e && e.message || e).slice(0, 80) });
    else res.end();
  }
}
