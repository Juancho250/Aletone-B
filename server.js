const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');

const YTDLP_PATH = path.join(__dirname, 'yt-dlp');
const COOKIES_SOURCE = '/etc/secrets/cookies.txt';
const COOKIES_FILE = path.join(__dirname, 'yt-cookies.txt');

if (fs.existsSync(COOKIES_SOURCE)) {
  try { fs.copyFileSync(COOKIES_SOURCE, COOKIES_FILE); } catch (e) {}
}

try {
  if (!fs.existsSync(YTDLP_PATH)) {
    execSync(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${YTDLP_PATH}"`, { stdio: 'inherit' });
  }
  execSync(`chmod a+rx "${YTDLP_PATH}"`, { stdio: 'inherit' });
  console.log('yt-dlp:', execSync(`"${YTDLP_PATH}" --version`).toString().trim());
} catch (e) { console.error('yt-dlp error:', e.message); }

const ffmpegBin = require('ffmpeg-static');
process.env.PATH = `${__dirname}:${path.dirname(ffmpegBin)}:${process.env.PATH}`;

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['*'] }));
app.options('*', cors());
app.use(express.json());
app.use('/downloads', express.static(DOWNLOADS_DIR));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(s) {
  if (!s) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function sanitize(n) {
  return (n || 'track').replace(/[^a-z0-9\-_. ]/gi, '_').substring(0, 100);
}

// fetchJSON con múltiples User-Agents para evitar bloqueos
const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
let uaIdx = 0;

async function fetchJSON(url, timeoutMs = 15000, extraHeaders = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const ua = UA_LIST[uaIdx++ % UA_LIST.length];
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': ua, 'Accept': 'application/json', ...extraHeaders },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ─── JioSaavn — múltiples endpoints de fallback ───────────────────────────────
const JSV_APIS = [
  'https://saavn.dev',
  'https://jiosaavn-api-privatecvc2.vercel.app',
];

async function jiosaavnSearch(q, limit = 15) {
  for (const base of JSV_APIS) {
    // intenta query completo y simplificado
    const queries = [q, q.split(' ').slice(0, 2).join(' ')];
    for (const query of queries) {
      try {
        const data = await fetchJSON(
          `${base}/api/search/songs?query=${encodeURIComponent(query)}&page=1&limit=${limit}`,
          12000
        );
        const results = (data?.data?.results || []).map(s => ({
          id: `jsv_${s.id}`,
          title: s.name || '',
          artist: (s.artists?.primary || []).map(a => a.name).join(', ') || '',
          duration: s.duration || 0,
          durationStr: fmt(s.duration),
          thumbnail: s.image?.[2]?.url || s.image?.[1]?.url || '',
          source: 'jiosaavn',
        })).filter(s => s.id && s.title);
        if (results.length > 0) {
          console.log(`[JioSaavn search] ok via ${base} para "${query}"`);
          return results;
        }
      } catch (e) {
        console.warn(`[JioSaavn search] ${base}:`, e.message);
      }
    }
  }
  return [];
}

async function jiosaavnStreamUrl(trackId) {
  const realId = trackId.replace('jsv_', '');
  for (const base of JSV_APIS) {
    try {
      const data = await fetchJSON(`${base}/api/songs/${realId}`, 12000);
      const song = data?.data?.[0];
      const urls = song?.downloadUrl || [];
      const url = [...urls].reverse().find(u => u?.url)?.url;
      if (url) return url;
    } catch (e) {
      console.warn(`[JioSaavn stream] ${base}:`, e.message);
    }
  }
  throw new Error('JioSaavn: no stream URL en ningún endpoint');
}

// ─── YouTube search via yt-dlp (solo búsqueda, no stream) ────────────────────
async function ytdlpSearch(q, limit = 15) {
  const hasCookies = fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 100;
  const cookieFlag = hasCookies ? `--cookies "${COOKIES_FILE}"` : '';
  try {
    const raw = await new Promise((resolve, reject) => {
      exec(
        `"${YTDLP_PATH}" ${cookieFlag} --extractor-args "youtube:player_client=mweb" --no-warnings --no-check-certificates "ytsearch${limit}:${q}" --dump-json --flat-playlist --no-playlist`,
        { maxBuffer: 1024 * 1024 * 20, timeout: 30000 },
        (err, stdout, stderr) => err ? reject(stderr || err.message) : resolve(stdout.trim())
      );
    });
    return raw.split('\n').filter(Boolean).map(line => {
      try {
        const d = JSON.parse(line);
        if (!d.id || d.id.length !== 11) return null;
        return {
          id: d.id, title: d.title || '', artist: d.uploader || d.channel || '',
          duration: d.duration || 0, durationStr: fmt(d.duration),
          thumbnail: d.thumbnail || `https://img.youtube.com/vi/${d.id}/mqdefault.jpg`,
          source: 'youtube',
        };
      } catch { return null; }
    }).filter(Boolean);
  } catch (e) {
    console.warn('[yt-dlp search]', String(e).substring(0, 100));
    return [];
  }
}

// ─── Invidious search (fallback para búsqueda) ────────────────────────────────
const INVIDIOUS = [
  'https://inv.tux.pizza',
  'https://invidious.io.lol',
  'https://invidious.privacyredirect.com',
  'https://yt.artemislena.eu',
  'https://inv.nadeko.net',
  'https://invidious.fdn.fr',
];
let invIdx = 0;

async function invSearch(q, limit = 15) {
  for (let i = 0; i < INVIDIOUS.length; i++) {
    const base = INVIDIOUS[invIdx++ % INVIDIOUS.length];
    try {
      const data = await fetchJSON(`${base}/api/v1/search?q=${encodeURIComponent(q)}&type=video&page=1`, 8000);
      const results = (Array.isArray(data) ? data : []).slice(0, limit).map(v => ({
        id: v.videoId, title: v.title || '', artist: v.author || '',
        duration: v.lengthSeconds || 0, durationStr: fmt(v.lengthSeconds),
        thumbnail: `https://img.youtube.com/vi/${v.videoId}/mqdefault.jpg`,
        source: 'youtube',
      })).filter(v => v.id?.length === 11);
      if (results.length > 0) return results;
    } catch (e) {
      console.warn(`[Invidious search ${base}]`, e.message);
    }
  }
  return [];
}

// ─── YouTube stream via redirect (yt-dlp resuelve URL, cliente hace el request) ──
async function ytGetAudioUrl(videoId) {
  const hasCookies = fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 100;
  const cookieFlag = hasCookies ? `--cookies "${COOKIES_FILE}"` : '';
  const clients = ['mweb', 'tv_embedded', 'ios', 'web'];

  for (const client of clients) {
    try {
      const cmd = `"${YTDLP_PATH}" ${cookieFlag} --extractor-args "youtube:player_client=${client}" --no-warnings --no-check-certificates "https://www.youtube.com/watch?v=${videoId}" -f "bestaudio" --get-url`;
      const out = await new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 1024 * 1024 * 20, timeout: 45000 },
          (err, stdout, stderr) => err ? reject(stderr || err.message) : resolve(stdout.trim()));
      });
      const url = out.split('\n')[0].trim();
      if (url.startsWith('http')) {
        console.log(`[yt-dlp] ok client=${client}`);
        return url;
      }
    } catch (e) {
      console.warn(`[yt-dlp] client=${client}:`, String(e).substring(0, 100));
    }
  }
  throw new Error('yt-dlp: todos los clients fallaron');
}

// ─── Invidious audio URL ──────────────────────────────────────────────────────
async function invAudioUrl(videoId) {
  for (let i = 0; i < INVIDIOUS.length; i++) {
    const base = INVIDIOUS[invIdx++ % INVIDIOUS.length];
    try {
      const data = await fetchJSON(`${base}/api/v1/videos/${videoId}?fields=adaptiveFormats`, 10000);
      const streams = (data.adaptiveFormats || [])
        .filter(f => f.type?.startsWith('audio/') && f.url)
        .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
      if (streams.length > 0) return streams[0].url;
    } catch (e) {
      console.warn(`[Invidious audio ${base}]`, e.message);
    }
  }
  throw new Error('Invidious: todos fallaron');
}

// ─── ffmpeg pipe ──────────────────────────────────────────────────────────────
function pipeAudio(audioUrl, res, req, extraArgs = []) {
  const ff = spawn(ffmpegBin, [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    ...extraArgs, '-i', audioUrl,
    '-vn', '-ar', '44100', '-ac', '2', '-b:a', '128k', '-f', 'mp3', 'pipe:1',
  ]);
  ff.stdout.pipe(res);
  ff.stderr.on('data', () => {});
  req.on('close', () => { try { ff.kill('SIGKILL'); } catch (_) {} });
  ff.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  ff.on('close', code => { if (code !== 0 && !res.headersSent) res.status(500).end(); });
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({
  status: 'ok', message: 'Aletone API v5',
  cookiesLoaded: fs.existsSync(COOKIES_FILE),
  cookieBytes: fs.existsSync(COOKIES_FILE) ? fs.statSync(COOKIES_FILE).size : 0,
}));

// Search: JioSaavn primero → Invidious → yt-dlp
app.get('/api/search', async (req, res) => {
  const { q, limit = 15 } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta q' });

  const [jsvR, invR] = await Promise.allSettled([
    jiosaavnSearch(q, Number(limit)),
    invSearch(q, Number(limit)),
  ]);

  const jsv = jsvR.status === 'fulfilled' ? jsvR.value : [];
  const inv = invR.status === 'fulfilled' ? invR.value : [];

  const combined = [...jsv];
  const needed = Number(limit) - combined.length;
  if (needed > 0) combined.push(...inv.slice(0, needed));

  if (combined.length > 0) {
    return res.json({ results: combined, source: jsv.length > 0 ? 'mixed' : 'youtube' });
  }

  // Último recurso: yt-dlp search
  const ytR = await ytdlpSearch(q, Number(limit));
  if (ytR.length > 0) return res.json({ results: ytR, source: 'ytdlp' });

  res.status(500).json({ error: 'No se encontraron resultados' });
});

// Stream
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;

  // JioSaavn — pipe directo (funciona perfectamente)
  if (videoId.startsWith('jsv_')) {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    try {
      const audioUrl = await jiosaavnStreamUrl(videoId);
      console.log('[Stream] JioSaavn ok');
      pipeAudio(audioUrl, res, req);
    } catch (e) {
      console.error('[Stream JioSaavn]', e.message);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
    return;
  }

  // YouTube — redirect (el navegador descarga directamente, no pasa por Render)
  console.log('[Stream] YouTube redirect:', videoId);
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const url = await ytGetAudioUrl(videoId);
    console.log('[Stream] yt-dlp redirect ok');
    return res.redirect(302, url);
  } catch (e) {
    console.warn('[Stream] yt-dlp falló:', e.message);
  }

  try {
    const url = await invAudioUrl(videoId);
    console.log('[Stream] Invidious redirect ok');
    return res.redirect(302, url);
  } catch (e) {
    console.warn('[Stream] Invidious falló:', e.message);
  }

  if (!res.headersSent) res.status(500).json({ error: 'No se pudo obtener el stream de YouTube' });
});

// Download
app.post('/api/download', async (req, res) => {
  const { videoId, title } = req.body;
  if (!videoId) return res.status(400).json({ error: 'Falta videoId' });

  const filename = sanitize(title || videoId) + '.mp3';
  const filepath = path.join(DOWNLOADS_DIR, filename);

  if (fs.existsSync(filepath))
    return res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });

  try {
    let audioUrl;
    if (videoId.startsWith('jsv_')) {
      audioUrl = await jiosaavnStreamUrl(videoId);
      await new Promise((resolve, reject) => {
        const ff = spawn(ffmpegBin, [
          '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
          '-i', audioUrl, '-vn', '-ar', '44100', '-ac', '2', '-b:a', '192k', filepath,
        ]);
        ff.stderr.on('data', () => {});
        ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
        ff.on('error', reject);
      });
    } else {
      // Para YouTube, yt-dlp descarga directamente
      const hasCookies = fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 100;
      const cookieFlag = hasCookies ? `--cookies "${COOKIES_FILE}"` : '';
      await new Promise((resolve, reject) => {
        exec(
          `"${YTDLP_PATH}" ${cookieFlag} --extractor-args "youtube:player_client=mweb" --no-warnings --no-check-certificates "https://www.youtube.com/watch?v=${videoId}" -x --audio-format mp3 --audio-quality 0 -o "${filepath}"`,
          { maxBuffer: 1024 * 1024 * 50, timeout: 120000 },
          (err, stdout, stderr) => err ? reject(stderr || err.message) : resolve()
        );
      });
    }
    res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });
  } catch (err) {
    res.status(500).json({ error: 'Download failed', detail: String(err).substring(0, 300) });
  }
});

// Cleanup
setInterval(() => {
  try {
    const now = Date.now();
    fs.readdirSync(DOWNLOADS_DIR).forEach(f => {
      const fp = path.join(DOWNLOADS_DIR, f);
      if (now - fs.statSync(fp).mtimeMs > 86400000) fs.unlinkSync(fp);
    });
  } catch (_) {}
}, 3600000);

app.listen(PORT, () => console.log(`Aletone API v5 en puerto ${PORT}`));