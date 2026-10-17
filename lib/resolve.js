// Finds the downloadable files behind a post link. Shared by the Vercel API
// (api/download.js) and the Android app, which runs it on the phone itself.
//
// Supported: TikTok (via tikwm.com), X/Twitter (via api.fxtwitter.com), public
// Instagram posts/reels and public Facebook videos/reels (read from their own pages).
// If COBALT_API_URL is set (server only), any other link is tried against that cobalt instance.

export const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

// Only media from these hosts may be streamed through /api/download?file=,
// so the endpoint can't be used as an open proxy.
const MEDIA_HOSTS = [
  'tikwm.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tiktokv.com',
  'tiktokv.us', 'tiktokv.eu', 'byteoversea.com', 'ibytedtos.com', 'ibyteimg.com', 'muscdn.com',
  'video.twimg.com', 'pbs.twimg.com', 'cdninstagram.com', 'fbcdn.net',
  'googlevideo.com', 'ytimg.com', 'sc-cdn.net', 'snapchat.com', 'pinimg.com',
  'rapidcdn.app', 'snapcdn.app', 'saveig.app',
  // Instagram link-preview fixers (see IG_FIXERS); some serve the video from their own address.
  'loader.to', 'oceansaver.in', 'savenow.to',
  'tnktok.com', 'vxtiktok.com', 'tiktxk.com', 'tfxktok.com',
  'kkinstagram.com', 'vxinstagram.com', 'instagramez.com', 'kirkstagram.com', 'instagramfix.com', 'uuinstagram.com', 'ddinstagram.com', 'mbdinstagram.com'
];
const FRONTEND_HOST = /(^|\.)(piped[a-z0-9-]*|pipedproxy[a-z0-9-]*|inv|invidious[a-z0-9-]*|yewtu)\./i;


// Some CDNs check where a request comes from; send each the site it expects (or none).
export function mediaHeaders(u) {
  const h = { 'User-Agent': UA };
  let host = '';
  try { host = new URL(u).hostname; } catch { return h; }
  if (/tikwm\.com|tiktokcdn|tiktokv|byteoversea|ibyte|muscdn/.test(host)) h.Referer = 'https://www.tikwm.com/';
  else if (/twimg\.com$/.test(host)) h.Referer = 'https://x.com/';
  else if (/cdninstagram\.com$/.test(host)) h.Referer = 'https://www.instagram.com/';
  else if (/fbcdn\.net$/.test(host)) h.Referer = 'https://www.facebook.com/';
  else if (/pinimg\.com$/.test(host)) h.Referer = 'https://www.pinterest.com/';
  // Instagram fixers send ordinary browsers back to instagram.com; ask as the chat bot they serve.
  else if ((/instagram(?:ez|fix)?\.com$|kirkstagram\.com$/.test(host) && !/(^|\.)instagram\.com$/.test(host)) || /tnktok|vxtiktok|tiktxk|tfxktok/.test(host)) h['User-Agent'] = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
  return h;
}

export function allowedMedia(u) {
  try {
    const { protocol, hostname } = new URL(u);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    return MEDIA_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h)) || FRONTEND_HOST.test(hostname);
  } catch { return false; }
}

export function safeName(s, ext) {
  const base = String(s || 'video').replace(/[^\p{L}\p{M}\p{N} ._-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'video';
  return base + '.' + ext;
}

function proxied(file, name) {
  return '/api/download?file=' + encodeURIComponent(file) + '&name=' + encodeURIComponent(name);
}
const converted = (file, name) => proxied(file, name).replace('/api/download?', '/api/convert?');

export class UserError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}

// TikTok link-preview fixers (like fxtwitter): their page for a video carries og:video.
const TT_FIXERS = ['www.tnktok.com', 'vxtiktok.com', 'www.tiktxk.com', 'tfxktok.com'];
async function tiktokFixers(url) {
  const path = new URL(url).pathname;
  const one = async host => {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch('https://' + host + path, { headers: { 'User-Agent': BOT_UA, Accept: 'text/html' }, redirect: 'follow', signal: ctl.signal });
      if (!r.ok) return null;
      const m = pageMeta(await r.text());
      return m.video ? { video: new URL(m.video.replace(/&amp;/g, '&'), 'https://' + host + '/').href, title: m.desc || m.title, image: m.image } : null;
    } catch { return null; } finally { clearTimeout(tm); }
  };
  const res = await Promise.all(TT_FIXERS.map(one));
  return res.find(Boolean) || null;
}

async function tiktok(url) {
  let j = null, why = '';
  try {
    const r = await fetch('https://www.tikwm.com/api/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: new URLSearchParams({ url, hd: '1' })
    });
    why = 'tk:' + r.status;
    j = r.ok ? await r.json().catch(() => null) : null;
  } catch { why = 'tk:err'; }
  if (j && j.code !== 0 && /private/i.test(j.msg || '')) throw new UserError('private');
  if (!j || j.code !== 0 || !j.data) {
    // tikwm refuses or is busy: a link-preview site gives the video file instead.
    const f = await tiktokFixers(url);
    if (!f) throw new UserError('unavailable', why + ' fx:none');
    const title = (f.title || 'tiktok').slice(0, 140);
    const ok = allowedMedia(f.video);
    return { title, thumb: f.image, items: [{ type: 'video', hd: true, url: ok ? proxied(f.video, safeName(title, 'mp4')) : f.video, file: f.video, ...(ok ? {} : { direct: f.video }) }] };
  }
  const d = j.data;
  const abs = u => (u && u.startsWith('/') ? 'https://www.tikwm.com' + u : u);
  const title = d.title || (d.author && d.author.unique_id) || 'tiktok';
  const items = [];
  if (Array.isArray(d.images) && d.images.length) {
    d.images.forEach((img, i) => items.push({ type: 'photo', url: proxied(abs(img), safeName(title + ' ' + (i + 1), 'jpg')), thumb: abs(img) }));
  } else {
    if (d.hdplay) items.push({ type: 'video', hd: true, url: proxied(abs(d.hdplay), safeName(title, 'mp4')), file: abs(d.hdplay) });
    if (d.play) items.push({ type: 'video', hd: false, url: proxied(abs(d.play), safeName(title, 'mp4')), file: abs(d.play) });
  }
  if (d.music) items.push({ type: 'audio', url: proxied(abs(d.music), safeName(title, 'mp3')), file: abs(d.music) });
  return { title, thumb: abs(d.cover || d.origin_cover), items, duration: +d.duration || undefined };
}

async function twitter(url) {
  const id = (url.match(/\/status(?:es)?\/(\d+)/) || [])[1];
  if (!id) throw new UserError('link.invalid');
  const r = await fetch('https://api.fxtwitter.com/status/' + id, { headers: { 'User-Agent': UA } });
  if (r.status === 404) throw new UserError('unavailable');
  if (!r.ok) throw new UserError('fetch.fail');
  const j = await r.json();
  const t = j.tweet;
  if (!t) throw new UserError('unavailable');
  // The post's own text (without trailing t.co links) is the title; the account name if it has none.
  const text = (t.text || '').replace(/https?:\/\/t\.co\/\S+/g, '').replace(/\s+/g, ' ').trim();
  const who = t.author ? (t.author.name || t.author.screen_name || '') : '';
  const title = (text || who || 'X ' + id).slice(0, 140);
  const media = t.media || {};
  const items = [];
  (media.videos || []).forEach((v, i) => {
    // Pick a real MP4 (highest bitrate), never the .m3u8 streaming playlist.
    const mp4s = [...(v.formats || []), ...(v.variants || [])]
      .filter(f => f && f.url && (f.container === 'mp4' || /video\/mp4/.test(f.content_type || '') || /\.mp4(\?|$)/.test(f.url)))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const nm = safeName(title + (i ? ' ' + (i + 1) : ''), 'mp4');
    const res = u => { const m = u.match(/\/(\d+)x(\d+)\//); return m ? Math.min(+m[1], +m[2]) + 'p' : ''; };
    const list = mp4s.length ? mp4s.filter((f, k, a) => a.findIndex(g => res(g.url) === res(f.url)) === k) : (/\.m3u8(\?|$)/.test(v.url || '') ? [] : [{ url: v.url }]);
    list.forEach((f, k) => items.push({ type: 'video', hd: k === 0, label: res(f.url), url: proxied(f.url, nm), file: f.url, thumb: v.thumbnail_url }));
  });
  (media.photos || []).forEach((p, i) => items.push({ type: 'photo', url: proxied(p.url, safeName(title + ' ' + (i + 1), 'jpg')), file: p.url, thumb: p.url }));
  if (!items.length) throw new UserError('empty');
  const dur = (media.videos || []).map(v => +v.duration).find(x => x > 0);
  return { title, thumb: items[0].thumb, items, duration: dur || undefined };
}

const IG_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'X-IG-App-ID': '936619743392459',
  'Accept-Language': 'en-US,en;q=0.9'
};

// Instagram pages escape JSON several layers deep (\\\"video_url\\\":\\\"https:\\\/\\\/...).
function igUnescape(h) {
  for (let i = 0; i < 4; i++) {
    const n = h.replace(/\\+u0026/g, '&').replace(/\\+u0025/g, '%').replace(/\\+\//g, '/').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (n === h) break;
    h = n;
  }
  // Other \uXXXX escapes (e.g. \u002F in Next.js data); quotes and backslashes stay escaped.
  h = h.replace(/\\u([0-9a-fA-F]{4})/g, (m, x) => (/^00(22|5[cC])$/.test(x) ? m : String.fromCharCode(parseInt(x, 16))));
  return h.replace(/&amp;/g, '&');
}

// Instagram's GraphQL wants a csrftoken cookie that a plain page visit hands out.
async function igSession() {
  try {
    const r = await fetch('https://www.instagram.com/', { headers: { ...IG_HEADERS, Accept: 'text/html' } });
    const cookies = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || '']).join('; ');
    const csrf = (cookies.match(/csrftoken=([^;,\s]+)/) || [])[1] || '';
    const cookie = ['csrftoken', 'mid', 'ig_did', 'datr'].map(k => { const m = cookies.match(new RegExp(k + '=([^;,\\s]+)')); return m ? k + '=' + m[1] : ''; }).filter(Boolean).join('; ');
    return { csrf, cookie };
  } catch { return { csrf: '', cookie: '' }; }
}

function igMediaFrom(obj) {
  // GraphQL answers use either data.xdt_shortcode_media or data.shortcode_media / graphql.shortcode_media.
  const d = obj && (obj.data || obj.graphql || (obj.items && { shortcode_media: obj.items[0] }));
  return d && (d.xdt_shortcode_media || d.shortcode_media) || null;
}

async function instagram(url) {
  let u = new URL(url);
  // Share links (instagram.com/share/...) redirect to the real /reel/<code>/ address.
  if (u.pathname.startsWith('/share/')) {
    const r = await fetch(url, { headers: IG_HEADERS, redirect: 'follow' });
    u = new URL(r.url || url);   // the Android app's native fetch leaves r.url empty
  }
  const code = (u.pathname.match(/\/(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/) || [])[1];
  if (!code) throw new UserError('link.invalid');

  // Instagram rarely answers servers, so ask the helper sites first; they are quicker.
  const first = await igHelpers('https://www.instagram.com' + u.pathname, code);
  if (first.items.length) return { title: first.title || code, thumb: first.thumb, items: first.items };
  let media = null, why = first.why + ' ';
  const sess = await igSession();
  why += 'csrf:' + (sess.csrf ? 'y' : 'n');

  // 1) GraphQL, a few known endpoint / query-id combinations.
  const tries = [
    ['https://www.instagram.com/graphql/query', '8845758582119845'],
    ['https://www.instagram.com/api/graphql', '8845758582119845'],
    ['https://www.instagram.com/api/graphql', '10015901848480474']
  ];
  for (const [endpoint, docId] of tries) {
    if (media) break;
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          ...IG_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*',
          'X-FB-LSD': 'AVqbxe3J_YA', 'X-ASBD-ID': '129477', 'X-CSRFToken': sess.csrf || 'missing',
          'X-FB-Friendly-Name': 'PolarisPostActionLoadPostQueryQuery', 'X-Requested-With': 'XMLHttpRequest',
          Origin: 'https://www.instagram.com', Referer: 'https://www.instagram.com/reel/' + code + '/',
          'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
          ...(sess.cookie ? { Cookie: sess.cookie } : {})
        },
        body: new URLSearchParams({
          av: '0', __d: 'www', __user: '0', __a: '1', __req: '3', dpr: '2', __ccg: 'UNKNOWN', lsd: 'AVqbxe3J_YA', jazoest: '2957',
          fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: 'PolarisPostActionLoadPostQueryQuery', server_timestamps: 'true',
          variables: JSON.stringify({ shortcode: code, fetch_tagged_user_count: null, hoisted_comment_id: null, hoisted_reply_id: null }),
          doc_id: docId
        })
      });
      why += ' g' + (endpoint.includes('/api/') ? 'a' : 'q') + ':' + r.status;
      if (r.ok) { media = igMediaFrom(await r.json().catch(() => null)); if (!media) why += '-empty'; }
    } catch { why += ' g:err'; }
  }

  // 2) Old JSON view of the post page (works for some public posts without login).
  if (!media) {
    try {
      const r = await fetch('https://www.instagram.com/p/' + code + '/?__a=1&__d=dis', { headers: { ...IG_HEADERS, Accept: 'application/json', ...(sess.cookie ? { Cookie: sess.cookie } : {}) } });
      why += ' a1:' + r.status;
      if (r.ok) media = igMediaFrom(await r.json().catch(() => null));
    } catch { why += ' a1:err'; }
  }

  const items = [];
  let title = code, thumb;
  if (media) {
    const cap = media.edge_media_to_caption && media.edge_media_to_caption.edges[0];
    title = (cap && cap.node.text) || (media.caption && media.caption.text) || (media.owner && media.owner.username) || (media.user && media.user.username) || code;
    thumb = media.display_url || (media.image_versions2 && media.image_versions2.candidates[0].url);
    const nodes = media.edge_sidecar_to_children ? media.edge_sidecar_to_children.edges.map(e => e.node) : media.carousel_media || [media];
    nodes.forEach((n, i) => {
      const nm = title + (nodes.length > 1 ? ' ' + (i + 1) : '');
      const v = n.video_url || (n.video_versions && n.video_versions[0] && n.video_versions[0].url);
      const img = n.display_url || (n.image_versions2 && n.image_versions2.candidates[0].url);
      if (v) items.push({ type: 'video', hd: true, url: proxied(v, safeName(nm, 'mp4')), file: v, thumb: img });
      else if (img) items.push({ type: 'photo', url: proxied(img, safeName(nm, 'jpg')), file: img, thumb: img });
    });
  }

  // 3) Public embed page; its JSON is escaped several layers deep.
  if (!items.length) {
    for (const path of ['/p/' + code + '/embed/captioned/', '/reel/' + code + '/embed/']) {
      try {
        const r = await fetch('https://www.instagram.com' + path, { headers: { ...IG_HEADERS, Accept: 'text/html' } });
        why += ' e:' + r.status;
        if (!r.ok) continue;
        const html = igUnescape(await r.text());
        const vid = (html.match(/"video_url":"(https:[^"]+)"/) || [])[1];
        const img = (html.match(/"display_url":"(https:[^"]+)"/) || html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/) || [])[1];
        const user = (html.match(/"username":"([^"]+)"/) || [])[1];
        if (user) title = user + ' ' + code;
        thumb = thumb || img;
        if (vid) { items.push({ type: 'video', hd: true, url: proxied(vid, safeName(title, 'mp4')), file: vid, thumb: img }); break; }
        if (!/\/reels?\//.test(u.pathname) && img) { items.push({ type: 'photo', url: proxied(img, safeName(title, 'jpg')), file: img, thumb: img }); break; }
        why += '-nomedia';
      } catch { why += ' e:err'; }
    }
  }
  if (!items.length) throw new UserError('ig.blocked', why.trim());
  return { title, thumb, items, duration: media && +media.video_duration || undefined };
}

// Backup routes for Instagram (third-party services; they can change or stop any time).
// 1) Link-preview fixer sites (they answer quickly and work today, so they go first).
// 2) A cobalt server of our own, if COBALT_URL is set.
const IG_FIXERS = ['www.kkinstagram.com', 'www.vxinstagram.com', 'www.instagramez.com', 'kirkstagram.com', 'instagramfix.com', 'www.uuinstagram.com', 'mbdinstagram.com', 'd.ddinstagram.com'];
const BOT_UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';

async function igHelpers(url, title) {
  let why = '';
  const items = [];
  let thumb;
  const add = (u, type) => {
    if (!u || items.some(i => i.file === u)) return;
    const ok = allowedMedia(u);
    const nm = safeName(title || 'instagram', type === 'photo' ? 'jpg' : 'mp4');
    items.push({ type, hd: !items.length, url: ok ? proxied(u, nm) : u, file: u, ...(ok ? {} : { direct: true }) });
  };
  // Link-preview fixers (like fxtwitter for X) give chat apps an og:video for a post.
  if (!items.length) {
    const path = new URL(url).pathname;
    const one = async host => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
      try {
        const r = await fetch('https://' + host + path, { headers: { 'User-Agent': BOT_UA, Accept: 'text/html' }, redirect: 'follow', signal: ctl.signal });
        if (!r.ok) return { why: 'fx:' + r.status };
        const html = await r.text();
        const meta = n => ((html.match(new RegExp('<meta[^>]+(?:property|name)="' + n + '"[^>]+content="([^"]+)"')) ||
          html.match(new RegExp('<meta[^>]+content="([^"]+)"[^>]+(?:property|name)="' + n + '"')) || [])[1] || '').replace(/&amp;/g, '&');
        const v = meta('og:video:secure_url') || meta('og:video') || meta('og:video:url') || meta('twitter:player:stream');
        if (!v || /instagram\.com\/(?:p|reels?)\//.test(v)) return { why: 'fx:' + r.status + '-none' };
        return { why: 'fx:ok', video: new URL(v, 'https://' + host + '/').href, text: meta('og:description') || meta('og:title'), img: meta('og:image') };
      } catch { return { why: 'fx:err' }; } finally { clearTimeout(t); }
    };
    // All at once (each may be slow or dead); the first one to answer with a video wins.
    const notes = [];
    const hit = await new Promise(done => {
      let left = IG_FIXERS.length;
      IG_FIXERS.forEach(h => one(h).then(x => {
        notes.push(x.why);
        if (x.video) done(x); else if (!--left) done(null);
      }));
    });
    why += ' ' + notes.join(' ');
    if (hit) {
      if (hit.text && !/^instagram$/i.test(hit.text)) title = hit.text.replace(/\s+/g, ' ').slice(0, 140);
      thumb = thumb || hit.img || undefined;
      add(hit.video, 'video');
    }
  }
  // A cobalt server of our own (COBALT_URL, optional COBALT_KEY in Vercel settings) is tried first.
  const own = process.env.COBALT_URL ? [process.env.COBALT_URL.replace(/\/+$/, '')] : [];
  for (const base of own) {
    if (items.length) break;
    try {
      const key = base === own[0] && process.env.COBALT_KEY;
      const r = await fetch(base + '/', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(key ? { Authorization: 'Api-Key ' + key } : {}) }, body: JSON.stringify({ url }) });
      why += ' cb:' + r.status;
      const j = await r.json().catch(() => ({}));
      if (j.error && j.error.code) why += '-' + String(j.error.code).replace(/^error\.api\./, '');
      if (j.status === 'tunnel' || j.status === 'redirect') add(j.url, 'video');
      else if (j.status === 'picker') (j.picker || []).forEach(p => add(p.url, p.type === 'photo' ? 'photo' : 'video'));
    } catch { why += ' cb:err'; }
  }
  return { items, thumb, title, why: why.trim() };
}

// Fill in file sizes (for the "21.0 MB" label) with quick HEAD requests.
export async function addSizes(items) {
  await Promise.all(items.map(async it => {
    if (!it.file || it.type === 'photo') return;
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(it.file, { method: 'HEAD', headers: mediaHeaders(it.file), signal: ctl.signal });
      clearTimeout(t);
      const n = Number(r.headers.get('content-length'));
      if (r.ok && n > 0) it.size = n;
    } catch { /* size stays unknown */ }
  }));
  // `direct` lets the page fetch straight from the CDN when CORS allows, skipping this function.
  items.forEach(it => { if (it.file) it.direct = it.file; delete it.file; });
}

async function cobalt(url) {
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  const base = env.COBALT_API_URL || env.COBALT_URL;
  if (!base) throw new UserError('unsupported');
  const h = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (env.COBALT_API_KEY || env.COBALT_KEY) h.Authorization = 'Api-Key ' + (env.COBALT_API_KEY || env.COBALT_KEY);
  const r = await fetch(base, { method: 'POST', headers: h, body: JSON.stringify({ url, filenameStyle: 'basic' }) });
  const j = await r.json().catch(() => ({}));
  if (j.status === 'tunnel' || j.status === 'redirect') {
    return { title: j.filename || 'video', items: [{ type: 'video', hd: true, url: j.url, direct: true }] };
  }
  if (j.status === 'picker') {
    return { title: 'media', items: (j.picker || []).map(p => ({ type: p.type === 'photo' ? 'photo' : 'video', url: p.url, thumb: p.thumb, direct: true })) };
  }
  throw new UserError('unavailable');
}

// Facebook puts the video's direct addresses in JSON inside the post page.
const FB_KEYS = [
  ['browser_native_hd_url', true], ['playable_url_quality_hd', true], ['hd_src', true], ['progressive_hd', true],
  ['browser_native_sd_url', false], ['playable_url', false], ['sd_src', false], ['progressive_sd', false], ['any_mp4', false]
];

function fbUnescape(v) {
  try { return JSON.parse('"' + v + '"'); } catch { return v.replace(/\\\//g, '/'); }
}

// Header sets Facebook accepts. A partial set (e.g. only Sec-Fetch-Mode) gets HTTP 400.
const FB_BROWSER = {
  'User-Agent': IG_HEADERS['User-Agent'],
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0', 'Sec-Ch-Ua-Platform': '"Windows"'
};
// Facebook's own link-preview crawler; public videos get og:video tags.
const FB_CRAWLER = { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', Accept: '*/*' };

async function facebookPage(url, headers) {
  const r = await fetch(url, { headers, redirect: 'follow' });
  return { status: r.status, finalUrl: r.url, html: r.ok ? await r.text() : '' };
}

// /share/v/... and fb.watch links redirect to the real /reel/ or /videos/ address.
async function facebookCanonical(url) {
  if (!/\/share\/|fb\.watch/.test(url)) return url;
  for (const h of [FB_BROWSER, FB_CRAWLER]) {
    try {
      const r = await fetch(url, { headers: h, redirect: 'manual' });
      const loc = r.headers.get('location');
      if (loc && !/\/login/.test(loc)) return new URL(loc, url).href;
    } catch { /* try the next header set */ }
  }
  return url;
}

// Caption, uploader and picture from any of the fetched Facebook pages.
function fbInfo(pages) {
  const ent = v => v.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const weak = t => !t || /^(facebook|video|watch|reels?|log in.*|facebook video)$/i.test(t.trim());
  // "Caption | By Name | Facebook" -> "Caption"
  const clean = t => ent((t || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))).replace(/\s*\|\s*Facebook\s*$/i, '').replace(/\s*\|\s*By [^|]+$/i, '')
    .replace(/^[\d.,]+[KMB]?\s*views?\s*·\s*[\d.,]+[KMB]?\s*reactions?\s*\|\s*/i, '').replace(/\s+/g, ' ').trim();
  let title = '', author = '', thumb = '';
  for (const p of pages) {
    const html = p.html || '';
    const all = igUnescape(html);
    const meta = n => (html.match(new RegExp('<meta (?:property|name)="og:' + n + '" content="([^"]*)"')) || [])[1] || '';
    const cands = [
      meta('title'), meta('description'),
      // "message":{"delight_ranges":[],...,"text":"caption"}
      (all.match(/"message":\{(?:[^{}]|\{[^{}]*\})*?"text":"([^"]{2,500})"/) || [])[1],
      (all.match(/"title":\{(?:[^{}]|\{[^{}]*\})*?"text":"([^"]{2,500})"/) || [])[1],
      (all.match(/"accessibility_caption":"([^"]{2,500})"/) || [])[1],
      (html.match(/<title>([^<]*)<\/title>/) || [])[1]
    ];
    if (!title) title = cands.map(clean).find(t => !weak(t)) || '';
    if (!author) author = clean((all.match(/"owner":\{(?:[^{}]|\{[^{}]*\})*?"name":"([^"]{2,80})"/) || [])[1] ||
      ((meta('title').match(/\|\s*By ([^|]+)\|/) || [])[1]) || '');
    if (!thumb) thumb = ent(meta('image')) || (all.match(/"preferred_thumbnail":\{"image":\{"uri":"(https:[^"]+)"/) ||
      all.match(/"thumbnailImage":\{"uri":"(https:[^"]+)"/) || all.match(/"first_frame_thumbnail":"(https:[^"]+)"/) || [])[1] || '';
  }
  return { title, author, thumb: thumb || undefined };
}

async function facebook(url) {
  const real = await facebookCanonical(url);
  const attempts = [
    ['e', 'https://www.facebook.com/plugins/video.php?show_text=false&href=' + encodeURIComponent(real), FB_BROWSER],
    ['d', real, FB_BROWSER],
    ['c', real, FB_CRAWLER],
    ['b', real.replace('://www.', '://mbasic.').replace('://m.', '://mbasic.'), { ...FB_BROWSER, 'User-Agent': UA, 'Sec-Ch-Ua-Mobile': '?1', 'Sec-Ch-Ua-Platform': '"Android"' }]
  ];
  // A numeric video id lets us ask the embed player and the mobile page in the forms they answer best.
  const vid = (real.match(/\/(?:reel|videos|watch\/live)\/(?:[^/?]*\/)?(\d{6,})|[?&](?:v|video_id)=(\d{6,})/) || []).slice(1).find(Boolean);
  if (vid) attempts.push(
    ['ev', 'https://www.facebook.com/plugins/video.php?show_text=false&href=' + encodeURIComponent('https://www.facebook.com/video.php?v=' + vid), FB_BROWSER],
    ['m', 'https://m.facebook.com/video.php?v=' + vid, { ...FB_BROWSER, 'User-Agent': UA, 'Sec-Ch-Ua-Mobile': '?1', 'Sec-Ch-Ua-Platform': '"Android"' }]
  );
  // Which kind of address the share link led to (reel, video, post, group ...), for the error note.
  const kind = (new URL(real).pathname.match(/^\/(reel|videos?|watch|groups|permalink|story|photo|share)/) || [, real.includes('/posts/') ? 'posts' : 'other'])[1];
  let why = (real !== url ? 'r:' : '') + kind + (vid ? '#' : '') + ' ';
  const found = {};
  let page = { html: '', finalUrl: url }, best = page;
  for (const [tag, u, h] of attempts) {
    try { page = await facebookPage(u, h); } catch { why += tag + ':err '; continue; }
    why += tag + ':' + page.status + (/\/login/.test(page.finalUrl) ? '-login' : '') + ' ';
    // Same search that worked first (raw page, one level of escaping) ...
    for (const [k] of FB_KEYS) {
      const m = page.html.match(new RegExp('"' + k + '":"([^"]+)"'));
      if (m && !found[k]) found[k] = fbUnescape(m[1]);
    }
    // ... then the page with every layer of escaping removed.
    const text = igUnescape(page.html);
    for (const [k] of FB_KEYS) {
      const m = text.match(new RegExp('"' + k + '":"(https:[^"]+)"'));
      if (m && !found[k]) found[k] = m[1];
    }
    // Newer pages: "progressive_url":"https://...","failure_reason":null,"metadata":{"quality":"HD"}
    for (const m of text.matchAll(/"progressive_url":"(https:[^"]+)"[^}]{0,120}?"quality":"(HD|SD)"/g)) {
      const k = m[2] === 'HD' ? 'progressive_hd' : 'progressive_sd';
      if (!found[k]) found[k] = m[1];
    }
    if (!Object.keys(found).length) {
      // Last resort: any progressive .mp4 on Facebook's video CDN in the page.
      const any = text.match(/https:\/\/video[^"'\s<>\\]*?\.fbcdn\.net\/[^"'\s<>\\]+?\.mp4[^"'\s<>\\]*/);
      if (any) found.any_mp4 = any[0];
    }
    // mbasic pages link the file directly: /video_redirect/?src=<encoded mp4>
    const vr = page.html.match(/video_redirect\/\?src=([^"&]+)/);
    if (vr && !found.sd_src) found.sd_src = decodeURIComponent(vr[1].replace(/&amp;/g, '&'));
    const og = page.html.match(/<meta property="og:video(?::secure_url|:url)?" content="([^"]+)"/);
    if (og && !found.og) found.og = og[1].replace(/&amp;/g, '&');
    if (/og:title/.test(page.html) && !/og:title/.test(best.html)) best = page;
    if (Object.keys(found).length) break;
  }
  why = why.trim();
  if (/og:title/.test(best.html)) page = best;
  const hd = FB_KEYS.filter(([, h]) => h).map(([k]) => found[k]).find(Boolean);
  const sd = FB_KEYS.filter(([, h]) => !h).map(([k]) => found[k]).find(Boolean) || found.og;
  if (!hd && !sd) throw new UserError('fb.blocked', why + '-nomedia');
  const pages = [page];
  // The page that had the video (often the embed player) usually has no caption,
  // so fetch the link-preview and normal pages just for the title when needed.
  let info = fbInfo(pages);
  for (const [tag, u, h] of [['c', real, FB_CRAWLER], ['d', real, FB_BROWSER]]) {
    if (info.title) break;
    try { pages.push(await facebookPage(u, h)); info = fbInfo(pages); why += ' t' + tag; } catch { /* keep what we have */ }
  }
  const title = (info.title || info.author || 'Facebook video').replace(/\s+/g, ' ').slice(0, 140);
  const thumb = info.thumb;
  const items = [];
  if (hd) items.push({ type: 'video', hd: true, url: proxied(hd, safeName(title, 'mp4')), file: hd });
  if (sd && sd !== hd) items.push({ type: 'video', hd: false, url: proxied(sd, safeName(title, 'mp4')), file: sd });
  const ms = pages.map(p => (igUnescape(p.html || '').match(/"playable_duration_in_ms":(\d+)/) || [])[1]).find(Boolean);
  return { title, thumb, items, duration: ms ? ms / 1000 : undefined };
}


// ---- YouTube ----
const YT_ID = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

const YT_CLIENTS = [
  { tag: 'vr', num: '28', ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    client: { clientName: 'ANDROID_VR', clientVersion: '1.60.19', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' } },
  { tag: 'ios', num: '5', ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' } },
  { tag: 'and', num: '3', ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
    client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, osName: 'Android', osVersion: '14' } },
  { tag: 'vr2', num: '28', ua: 'com.google.android.apps.youtube.vr.oculus/1.57.29 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    client: { clientName: 'ANDROID_VR', clientVersion: '1.57.29', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' } },
  { tag: 'tve', num: '85', ua: 'Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko)',
    client: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0' }, extra: { thirdParty: { embedUrl: 'https://www.youtube.com/' } } }
];

async function youtube(url) {
  const id = (url.match(YT_ID) || [])[1];
  if (!id) throw new UserError('link.invalid');
  const thumb = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
  let why = '';
  // 1) YouTube's own player API, asking as several of its apps at once (4 s each); the first
  // that gets plain file addresses wins. Servers usually get "sign in to confirm you're not
  // a bot" from all of them; then the converter below is used. YouTube's oEmbed (title) is
  // asked at the same time, so that path doesn't wait either.
  const one = async c => {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': c.num, 'X-YouTube-Client-Version': c.client.clientVersion, 'User-Agent': c.ua, Origin: 'https://www.youtube.com' },
        body: JSON.stringify({ videoId: id, contentCheckOk: true, racyCheckOk: true, context: { client: { hl: 'en', gl: 'US', ...c.client }, ...(c.extra || {}) } })
      });
      if (!r.ok) return { why: c.tag + ':' + r.status };
      const j = await r.json();
      const st = (j.playabilityStatus || {}).status;
      if (st !== 'OK' || !j.streamingData) return { why: c.tag + ':' + st };
      const title = (j.videoDetails || {}).title || 'YouTube video';
      // Only formats with a plain address (some apps get scrambled ones we can't use).
      const muxed = (j.streamingData.formats || []).filter(f => f.url && /video\/mp4/.test(f.mimeType)).sort((a, b) => (b.height || 0) - (a.height || 0));
      const audio = (j.streamingData.adaptiveFormats || []).filter(f => f.url && /audio\/mp4/.test(f.mimeType)).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      const items = muxed.map((f, i) => ({ type: 'video', hd: i === 0, label: f.qualityLabel || '', url: proxied(f.url, safeName(title, 'mp4')), file: f.url }));
      if (audio) items.push({ type: 'audio', label: 'M4A', url: proxied(audio.url, safeName(title, 'm4a')), file: audio.url });
      if (!items.some(i => i.type === 'video')) return { why: c.tag + ':noplain' };
      return { out: { title, thumb, items, duration: +(j.videoDetails || {}).lengthSeconds || undefined } };
    } catch { return { why: c.tag + ':err' }; } finally { clearTimeout(tm); }
  };
  const oembed = fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id))
    .then(r => r.ok ? r.json() : null).then(j => j && j.title).catch(() => null);
  const tries = await Promise.all(YT_CLIENTS.map(one));
  const hit = tries.find(x => x.out);
  if (hit) return hit.out;
  why = tries.map(x => x.why).join(' ');
  // 2) Our own cobalt server, if one is set up (COBALT_URL in the Vercel settings).
  const env = (typeof process !== 'undefined' && process.env) || {};
  if (env.COBALT_API_URL || env.COBALT_URL) {
    try { return await cobalt(url); } catch { why += ' cb:fail'; }
  }
  // 3) A converter site (loader.to) makes the file on its own servers; the page starts the
  // job and waits for it through /api/download?yt=... (see ytJob). Title from YouTube's oEmbed.
  const title = (await oembed) || 'YouTube video';
  const job = (fmt, ext) => '/api/download?yt=' + fmt + '&v=' + id + '&name=' + encodeURIComponent(safeName(title, ext));
  return {
    title, thumb, why: why.trim(),
    items: [
      { type: 'video', hd: true, label: '1080p', url: job('1080', 'mp4'), prep: true },
      { type: 'video', label: '720p', url: job('720', 'mp4'), prep: true },
      { type: 'video', label: '360p', url: job('360', 'mp4'), prep: true },
      { type: 'audio', label: 'MP3', url: job('mp3', 'mp3'), prep: true }
    ]
  };
}

// YouTube search for the home screen (videos only). YouTube's own search API, with the
// results page as a fallback; both are read by walking the JSON for videoRenderer entries.
// sort: '' relevance, 'd' newest first, 'w' this week (videos only in each case).
const YT_SORT = { '': 'EgIQAQ==', d: 'CAISAhAB', w: 'EgQIAxAB' };
export async function ytSearch(q, sort) {
  q = String(q || '').trim().slice(0, 120);
  const sp = YT_SORT[sort] || YT_SORT[''];
  if (!q) return { items: [] };
  const pick = data => {
    const out = [], seen = new Set();
    const walk = o => {
      if (!o || typeof o !== 'object' || out.length >= 30) return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      const v = o.videoRenderer;
      if (v && v.videoId && !seen.has(v.videoId)) {
        seen.add(v.videoId);
        const text = x => x ? (x.simpleText || (x.runs || []).map(r => r.text).join('')) : '';
        out.push({
          id: v.videoId, title: text(v.title), ch: text(v.ownerText || v.longBylineText),
          dur: text(v.lengthText), views: text(v.shortViewCountText || v.viewCountText), ago: text(v.publishedTimeText),
          thumb: 'https://i.ytimg.com/vi/' + v.videoId + '/hq720.jpg'
        });
      }
      for (const k in o) if (k !== 'videoRenderer') walk(o[k]);
    };
    walk(data);
    return out;
  };
  let why = '';
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': PAGE_UA['User-Agent'], Origin: 'https://www.youtube.com' },
      body: JSON.stringify({ query: q, params: sp, context: { client: { clientName: 'WEB', clientVersion: '2.20250312.04.00', hl: 'en', gl: 'PK' } } })
    });
    why += 's:' + r.status;
    if (r.ok) { const items = pick(await r.json()); if (items.length) return { items }; why += '-empty'; }
  } catch { why += 's:err'; }
  try {
    const r = await fetch('https://www.youtube.com/results?sp=' + encodeURIComponent(sp) + '&search_query=' + encodeURIComponent(q), {
      headers: { ...PAGE_UA, Cookie: 'CONSENT=YES+1; SOCS=CAI' }
    });
    why += ' h:' + r.status;
    const html = r.ok ? await r.text() : '';
    const m = html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (m) { const items = pick(JSON.parse(m[1])); if (items.length) return { items }; }
  } catch { why += ' h:err'; }
  throw new UserError('yt.search', why.trim());
}

// Videos related to one YouTube video (the list under the player): YouTube's "next" list,
// else a search for the start of its title.
export async function ytRelated(id, title) {
  id = String(id || '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new UserError('link.invalid');
  const text = x => x ? (x.simpleText || (x.runs || []).map(r => r.text).join('') || x.content || '') : '';
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': PAGE_UA['User-Agent'], Origin: 'https://www.youtube.com' },
      body: JSON.stringify({ videoId: id, context: { client: { clientName: 'WEB', clientVersion: '2.20250312.04.00', hl: 'en', gl: 'PK' } } })
    });
    if (r.ok) {
      const out = [], seen = new Set([id]);
      const walk = o => {
        if (!o || typeof o !== 'object' || out.length >= 25) return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        const c = o.compactVideoRenderer || o.videoRenderer;
        if (c && c.videoId && !seen.has(c.videoId)) {
          seen.add(c.videoId);
          out.push({ id: c.videoId, title: text(c.title), ch: text(c.longBylineText || c.shortBylineText || c.ownerText), dur: text(c.lengthText),
            views: text(c.shortViewCountText || c.viewCountText), ago: text(c.publishedTimeText), thumb: 'https://i.ytimg.com/vi/' + c.videoId + '/hq720.jpg' });
        }
        const l = o.lockupViewModel;   // newer layout
        if (l && l.contentId && /VIDEO/.test(l.contentType || '') && !seen.has(l.contentId)) {
          seen.add(l.contentId);
          const md = (l.metadata || {}).lockupMetadataViewModel || {};
          const rows = (((md.metadata || {}).contentMetadataViewModel || {}).metadataRows || []).map(rw => (rw.metadataParts || []).map(p => text(p.text)).filter(Boolean).join(' · '));
          const badge = JSON.stringify(l.contentImage || {}).match(/"text":"(\d+(?::\d+)+)"/);
          out.push({ id: l.contentId, title: text(md.title), ch: rows[0] || '', views: rows[1] || '', dur: badge ? badge[1] : '',
            thumb: 'https://i.ytimg.com/vi/' + l.contentId + '/hq720.jpg' });
        }
        for (const k in o) if (k !== 'compactVideoRenderer' && k !== 'videoRenderer' && k !== 'lockupViewModel') walk(o[k]);
      };
      walk(await r.json());
      if (out.length >= 4) return { items: out };
    }
  } catch { /* use the search below */ }
  const q = String(title || '').replace(/[|#()\[\]]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  const res = await ytSearch(q || 'trending');
  return { items: res.items.filter(v => v.id !== id) };
}

// TikTok list for the home screen (via tikwm.com, same as downloads): trending in a
// region, or a keyword search.
export async function tiktokFeed(q) {
  q = String(q || '').trim().slice(0, 100);
  const abs = u => !u ? '' : /^https?:/.test(u) ? u : 'https://www.tikwm.com' + u;
  // tikwm allows about one request a second and sometimes answers with an empty list:
  // try a couple of times, and for "trending" fall back to a search.
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  const ask = async kw => {
    const r = kw
      ? await fetch('https://www.tikwm.com/api/feed/search', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
          body: new URLSearchParams({ keywords: kw, count: '20', cursor: '0', hd: '1' }) })
      : await fetch('https://www.tikwm.com/api/feed/list?region=PK&count=20', { headers: { 'User-Agent': UA } });
    const j = await r.json().catch(() => ({}));
    return { list: Array.isArray(j.data) ? j.data : (j.data && j.data.videos) || [], why: 'tk' + (kw ? 's' : 'l') + ':' + r.status + ':' + (j.msg || j.code) };
  };
  const tries = q ? [q, q] : ['', 'pakistan trending', 'viral'];
  let list = [], why = '';
  for (const [n, kw] of tries.entries()) {
    if (n) await sleep(1200);
    try { const a = await ask(kw); list = a.list; why += ' ' + a.why; } catch { why += ' tk:err'; }
    if (list.length) break;
  }
  if (!list.length) throw new UserError('tt.feed', why.trim());
  // "3 days ago" from the upload time (seconds since 1970).
  const ago = t => {
    if (!t) return '';
    const d = Math.max(0, Date.now() / 1000 - t), u = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
    for (const [n, w] of u) if (d >= n) { const k = Math.floor(d / n); return k + ' ' + w + (k > 1 ? 's' : '') + ' ago'; }
    return 'just now';
  };
  const mmss = s => s ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : '';
  const short = n => !n ? '' : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M views' : n >= 1e3 ? Math.round(n / 1e3) + 'K views' : n + ' views';
  return {
    items: list.filter(v => v.video_id || v.id).map(v => {
      const id = v.video_id || v.id, a = v.author || {};
      return { id, title: v.title || '', ch: a.nickname || a.unique_id || '', dur: mmss(v.duration), views: short(v.play_count), ago: ago(v.create_time),
        thumb: abs(v.cover || v.origin_cover), play: abs(v.play || v.wmplay),
        link: 'https://www.tiktok.com/@' + (a.unique_id || 'user') + '/video/' + id };
    })
  };
}

// Converter jobs for YouTube (third-party; may change or stop). start -> {job}, then
// poll -> {pct, url} until the file is ready.
const YT_CONVERTERS = ['https://loader.to', 'https://p.oceansaver.in'];
export async function ytJob(q) {
  const h = { 'User-Agent': PAGE_UA['User-Agent'], Accept: 'application/json, text/plain, */*', Referer: 'https://loader.to/' };
  if (q.job) {
    const [b, jid] = String(q.job).split(':');
    const base = YT_CONVERTERS[+b];
    if (!base || !jid) throw new UserError('link.invalid');
    const r = await fetch(base + '/ajax/progress.php?id=' + encodeURIComponent(jid), { headers: h });
    const j = await r.json().catch(() => ({}));
    const pct = Math.round((+j.progress || 0) / 10);
    if (j.download_url && (+j.success === 1 || j.success === true)) return { pct: 100, url: j.download_url };
    if (+j.success === 0 && pct >= 100) throw new UserError('yt.blocked', 'cv:' + (j.text || 'failed'));
    return { pct: Math.min(99, pct), text: j.text || '' };
  }
  const id = String(q.v || '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new UserError('link.invalid');
  const fmt = /^(360|480|720|1080|mp3)$/.test(q.yt) ? q.yt : '720';
  let why = '';
  for (const [i, base] of YT_CONVERTERS.entries()) {
    try {
      const r = await fetch(base + '/ajax/download.php?format=' + fmt + '&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id), { headers: h });
      why += 'cv' + i + ':' + r.status + ' ';
      const j = await r.json().catch(() => ({}));
      if (j.id) return { job: i + ':' + j.id };
    } catch { why += 'cv' + i + ':err '; }
  }
  throw new UserError('yt.blocked', why.trim());
}

// ---- Pages that carry the video in their own HTML (Snapchat, Pinterest, many others) ----
const PAGE_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml' };

function pageMeta(html) {
  const ent = v => (v || '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const m = n => ent((html.match(new RegExp('<meta[^>]+(?:property|name)="(?:og|twitter):' + n + '"[^>]+content="([^"]*)"')) ||
    html.match(new RegExp('<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="(?:og|twitter):' + n + '"')) || [])[1]);
  return { title: m('title') || ent((html.match(/<title>([^<]*)<\/title>/) || [])[1]), desc: m('description'), image: m('image'), video: m('video:secure_url') || m('video:url') || m('video') || m('player:stream') };
}

async function webPage(url, site, pick) {
  const r = await fetch(url, { headers: PAGE_UA, redirect: 'follow' });
  if (r.status === 404) throw new UserError('unavailable');
  if (!r.ok) throw new UserError('fetch.fail', site + ':' + r.status);
  const raw = await r.text();
  const html = igUnescape(raw);
  const meta = pageMeta(raw);
  const files = [...new Set(pick(html, meta).filter(Boolean))];
  if (!files.length) throw new UserError('empty', site + ':nomedia');
  const title = (meta.title || meta.desc || site).replace(/\s+/g, ' ').trim().slice(0, 140);
  const items = files.slice(0, 2).map((f, i) => {
    const ok = allowedMedia(f);
    return { type: 'video', hd: i === 0, url: ok ? proxied(f, safeName(title, 'mp4')) : f, file: f, direct: ok ? undefined : true };
  });
  return { title, thumb: meta.image || undefined, items };
}

const snapchat = url => webPage(url, 'snap', (h, m) => [
  ...[...h.matchAll(/"(?:mediaUrl|videoUrl|contentUrl|mediaStreamUrl)":"(https:[^"]+)"/g)].map(x => x[1]).filter(u => !/\.(jpe?g|png|webp|gif)(\?|$)/i.test(u)),
  m.video
]);
const pinterest = url => webPage(url, 'pin', (h, m) => [
  ...[...h.matchAll(/https:\/\/v\d*\.pinimg\.com\/videos\/[^"'\s\\]+?\.mp4/g)].map(x => x[0]).sort((a, b) => (/720p|1080p/.test(b) ? 1 : 0) - (/720p|1080p/.test(a) ? 1 : 0)),
  m.video
]);
const anyPage = url => webPage(url, 'web', (h, m) => [
  m.video && !/\.m3u8|\/embed|youtube\.com/i.test(m.video) ? m.video : '',
  ...[...h.matchAll(/<(?:video|source)[^>]+src="(https:[^"]+\.mp4[^"]*)"/g)].map(x => x[1]),
  (h.match(/"(?:contentUrl|videoUrl|video_url|mp4Url)":"(https:[^"]+\.mp4[^"]*)"/) || [])[1]
]);

// Every video also gets an MP3 option: the sound of its smallest version, converted
// by the API (…&audio=1). Sites that already offer audio (TikTok, YouTube) keep theirs.
function withAudio(out) {
  if (!out || !out.items || out.items.some(i => i.type === 'audio')) return out;
  const vids = out.items.filter(i => i.type === 'video' && i.file && allowedMedia(i.file));
  if (!vids.length) return out;
  const src = vids[vids.length - 1];
  out.items.push({ type: 'audio', label: 'MP3', url: converted(src.file, safeName(out.title || 'audio', 'mp3')) + '&audio=1' });
  return out;
}

// When the best version is smaller than 720p/1080p, offer those sizes too, made by the API
// (…&scale=720|1080). They are enlarged copies, so they are marked `up`.
function withBigger(out) {
  if (!out || !out.items) return out;
  const vids = out.items.filter(i => i.type === 'video' && i.file && allowedMedia(i.file));
  const best = vids.map(i => ({ i, h: parseInt(i.label, 10) })).filter(x => x.h > 0).sort((a, b) => b.h - a.h)[0];
  if (!best) return out;
  [720, 1080].filter(h => h > best.h).forEach(h => out.items.unshift({
    type: 'video', label: h + 'p', up: true, url: converted(best.i.file, safeName(out.title || 'video', 'mp4')) + '&scale=' + h
  }));
  return out;
}

export async function resolve(url) {
  return withBigger(withAudio(await resolveSite(url)));
}

async function resolveSite(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { throw new UserError('link.invalid'); }
  if (/(^|\.)tiktok\.com$/.test(host)) return tiktok(url);
  if (/(^|\.)(twitter\.com|x\.com|fxtwitter\.com|vxtwitter\.com)$/.test(host)) return twitter(url);
  if (/(^|\.)(instagram\.com|instagr\.am)$/.test(host)) return instagram(url);
  if (/(^|\.)(facebook\.com|fb\.watch|fb\.com)$/.test(host)) return facebook(url);
  if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)) return youtube(url);
  if (/(^|\.)snapchat\.com$/.test(host)) return snapchat(url);
  if (/(^|\.)(pinterest\.[a-z.]+|pin\.it)$/.test(host)) return pinterest(url);
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  if (env.COBALT_API_URL || env.COBALT_URL) return cobalt(url);
  return anyPage(url);
}

