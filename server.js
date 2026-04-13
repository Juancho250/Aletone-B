const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');

const YTDLP_PATH = path.join(__dirname, 'yt-dlp');
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

function fmt(s) {
  if (!s) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function sanitize(n) {
  return (n || 'track').replace(/[^a-z0-9\-_. ]/gi, '_').substring(0, 100);
}
// Extrae la mejor URL de downloadUrl (mayor bitrate primero, que viene al final del array)
function getBestUrl(downloadUrl) {
  if (!Array.isArray(downloadUrl) || downloadUrl.length === 0) return null;
  return [...downloadUrl].reverse().find(u => u?.url)?.url || null;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

async function fetchJSON(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ─── JioSaavn endpoints ───────────────────────────────────────────────────────
// CLAVE: parseSearch extrae downloadUrl directo del resultado de búsqueda
// → el cliente puede reproducir sin segunda llamada al servidor
const JSV_ENDPOINTS = [
  {
    name: 'jiosaavn-api-2',
    searchUrl: (q, limit) => `https://jiosaavn-api-2.vercel.app/search/songs?query=${encodeURIComponent(q)}&page=1&limit=${limit}`,
    songUrl: (id) => `https://jiosaavn-api-2.vercel.app/songs/${id}`,
    parseSearch: (data) => {
      const items = data?.data?.results || data?.results || [];
      return items.map(s => ({
        id: `jsv_${s.id}`,
        title: s.name || s.title || '',
        artist: (s.artists?.primary || []).map(a => a.name).join(', ') || s.primaryArtists || '',
        duration: s.duration || 0,
        durationStr: fmt(s.duration),
        thumbnail: s.image?.[2]?.url || s.image?.[1]?.url || s.image?.[0]?.url || '',
        source: 'jiosaavn',
        streamUrl: getBestUrl(s.downloadUrl), // ← URL directa incluida aquí
      }));
    },
    parseStream: (data) => getBestUrl((data?.data?.[0] || data?.[0])?.downloadUrl),
  },
  {
    name: 'saavn.dev',
    searchUrl: (q, limit) => `https://saavn.dev/api/search/songs?query=${encodeURIComponent(q)}&page=1&limit=${limit}`,
    songUrl: (id) => `https://saavn.dev/api/songs/${id}`,
    parseSearch: (data) => {
      const items = data?.data?.results || [];
      return items.map(s => ({
        id: `jsv_${s.id}`,
        title: s.name || '',
        artist: (s.artists?.primary || []).map(a => a.name).join(', ') || '',
        duration: s.duration || 0,
        durationStr: fmt(s.duration),
        thumbnail: s.image?.[2]?.url || s.image?.[1]?.url || '',
        source: 'jiosaavn',
        streamUrl: getBestUrl(s.downloadUrl),
      }));
    },
    parseStream: (data) => getBestUrl(data?.data?.[0]?.downloadUrl),
  },
  {
    name: 'jiosaavn-api-privatecvc2',
    searchUrl: (q, limit) => `https://jiosaavn-api-privatecvc2.vercel.app/api/search/songs?query=${encodeURIComponent(q)}&page=1&limit=${limit}`,
    songUrl: (id) => `https://jiosaavn-api-privatecvc2.vercel.app/api/songs/${id}`,
    parseSearch: (data) => {
      const items = data?.data?.results || [];
      return items.map(s => ({
        id: `jsv_${s.id}`,
        title: s.name || '',
        artist: (s.artists?.primary || []).map(a => a.name).join(', ') || '',
        duration: s.duration || 0,
        durationStr: fmt(s.duration),
        thumbnail: s.image?.[2]?.url || s.image?.[1]?.url || '',
        source: 'jiosaavn',
        streamUrl: getBestUrl(s.downloadUrl),
      }));
    },
    parseStream: (data) => getBestUrl(data?.data?.[0]?.downloadUrl),
  },
];

async function jiosaavnSearch(q, limit = 15) {
  for (const ep of JSV_ENDPOINTS) {
    try {
      const data = await fetchJSON(ep.searchUrl(q, limit));
      const results = ep.parseSearch(data).filter(s => s.id && s.title);
      if (results.length > 0) {
        const withUrl = results.filter(s => s.streamUrl).length;
        console.log(`[Search] ✓ ${ep.name}: ${results.length} canciones, ${withUrl} con streamUrl`);
        return results;
      }
    } catch (e) {
      console.warn(`[Search] ✗ ${ep.name}:`, e.message);
    }
  }
  return [];
}

async function jiosaavnStreamUrl(trackId) {
  const realId = trackId.replace('jsv_', '');
  for (const ep of JSV_ENDPOINTS) {
    try {
      const data = await fetchJSON(ep.songUrl(realId));
      const url = ep.parseStream(data);
      if (url) { console.log(`[StreamURL] ✓ ${ep.name}`); return url; }
    } catch (e) {
      console.warn(`[StreamURL] ✗ ${ep.name}:`, e.message);
    }
  }
  throw new Error('Ningún endpoint JioSaavn devolvió URL de stream');
}

// ─── ffmpeg pipe ──────────────────────────────────────────────────────────────
function pipeAudio(audioUrl, res, req) {
  const ff = spawn(ffmpegBin, [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', audioUrl, '-vn', '-ar', '44100', '-ac', '2', '-b:a', '128k', '-f', 'mp3', 'pipe:1',
  ]);
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  ff.stdout.pipe(res);
  ff.stderr.on('data', () => {});
  req.on('close', () => { try { ff.kill('SIGKILL'); } catch (_) {} });
  ff.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  ff.on('close', code => { if (code !== 0 && !res.headersSent) res.status(500).end(); });
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'ok', message: 'Aletone API v7' }));

// BÚSQUEDA — devuelve streamUrl en cada canción para reproducción directa
app.get('/api/search', async (req, res) => {
  const { q, limit = 15 } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta q' });
  console.log(`[Search] "${q}"`);
  const results = await jiosaavnSearch(q, Number(limit));
  if (results.length > 0) return res.json({ results, source: 'jiosaavn' });
  res.status(503).json({ error: 'JioSaavn no disponible. Intenta de nuevo en unos minutos.' });
});

// PROXY STREAM — fallback cuando streamUrl directa falla (CORS, expirada, etc.)
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!videoId.startsWith('jsv_')) return res.status(400).json({ error: 'Solo IDs jsv_*' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const audioUrl = await jiosaavnStreamUrl(videoId);
    pipeAudio(audioUrl, res, req);
  } catch (e) {
    if (!res.headersSent) res.status(503).json({ error: e.message });
  }
});

// STREAM-URL — devuelve URL fresca (por si la del search expiró)
app.get('/api/stream-url/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!videoId.startsWith('jsv_')) return res.status(400).json({ error: 'Solo IDs jsv_*' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const url = await jiosaavnStreamUrl(videoId);
    res.json({ url });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// HEALTH CHECK
app.get('/api/health', async (req, res) => {
  const results = await Promise.allSettled(JSV_ENDPOINTS.map(async ep => {
    const t = Date.now();
    try {
      const data = await fetchJSON(ep.searchUrl('arijit singh', 3), 8000);
      const items = ep.parseSearch(data).filter(s => s.id && s.title);
      return { name: ep.name, ok: true, ms: Date.now()-t, songs: items.length, withStreamUrl: items.filter(s=>s.streamUrl).length };
    } catch(e) {
      return { name: ep.name, ok: false, ms: Date.now()-t, error: e.message };
    }
  }));
  res.json({ endpoints: results.map(r => r.value || r.reason), ts: new Date().toISOString() });
});

// DOWNLOAD
app.post('/api/download', async (req, res) => {
  const { videoId, title, streamUrl: directUrl } = req.body;
  if (!videoId?.startsWith('jsv_')) return res.status(400).json({ error: 'Solo JioSaavn' });

  const filename = sanitize(title || videoId) + '.mp3';
  const filepath = path.join(DOWNLOADS_DIR, filename);
  if (fs.existsSync(filepath))
    return res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });

  try {
    const audioUrl = directUrl || await jiosaavnStreamUrl(videoId);
    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegBin, [
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-i', audioUrl, '-vn', '-ar', '44100', '-ac', '2', '-b:a', '192k', filepath,
      ]);
      ff.stderr.on('data', () => {});
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)));
      ff.on('error', reject);
    });
    res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });
  } catch (err) {
    res.status(500).json({ error: 'Download failed', detail: String(err).substring(0, 200) });
  }
});

setInterval(() => {
  try {
    const now = Date.now();
    fs.readdirSync(DOWNLOADS_DIR).forEach(f => {
      const fp = path.join(DOWNLOADS_DIR, f);
      if (now - fs.statSync(fp).mtimeMs > 86400000) fs.unlinkSync(fp);
    });
  } catch (_) {}
}, 3600000);

app.listen(PORT, () => console.log(`Aletone API v7 en puerto ${PORT}`));