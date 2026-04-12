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

const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
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

// ─── JioSaavn — múltiples endpoints con sus rutas correctas ──────────────────
// Cada endpoint tiene rutas distintas y estructura de respuesta diferente
const JSV_ENDPOINTS = [
  {
    name: 'jiosaavn-api-2',
    base: 'https://jiosaavn-api-2.vercel.app',
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
      }));
    },
    parseStream: (data) => {
      const song = data?.data?.[0] || data?.[0];
      if (!song) return null;
      const urls = song?.downloadUrl || [];
      return [...urls].reverse().find(u => u?.url)?.url || null;
    },
  },
  {
    name: 'saavn.dev',
    base: 'https://saavn.dev',
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
      }));
    },
    parseStream: (data) => {
      const song = data?.data?.[0];
      if (!song) return null;
      const urls = song?.downloadUrl || [];
      return [...urls].reverse().find(u => u?.url)?.url || null;
    },
  },
  {
    name: 'saavn-api-six',
    base: 'https://saavn-api-six.vercel.app',
    searchUrl: (q, limit) => `https://saavn-api-six.vercel.app/api/search/songs?query=${encodeURIComponent(q)}&page=1&limit=${limit}`,
    songUrl: (id) => `https://saavn-api-six.vercel.app/api/songs/${id}`,
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
      }));
    },
    parseStream: (data) => {
      const song = data?.data?.[0];
      if (!song) return null;
      const urls = song?.downloadUrl || [];
      return [...urls].reverse().find(u => u?.url)?.url || null;
    },
  },
  {
    name: 'jiosaavn-api-privatecvc2',
    base: 'https://jiosaavn-api-privatecvc2.vercel.app',
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
      }));
    },
    parseStream: (data) => {
      const song = data?.data?.[0];
      if (!song) return null;
      const urls = song?.downloadUrl || [];
      return [...urls].reverse().find(u => u?.url)?.url || null;
    },
  },
];

// Caché de qué endpoints funcionan para no perder tiempo en los caídos
const endpointStatus = {};

async function jiosaavnSearch(q, limit = 15) {
  for (const ep of JSV_ENDPOINTS) {
    if (endpointStatus[ep.name] === 'down') continue;
    const queries = [q, q.split(' ').slice(0, 3).join(' ')];
    for (const query of queries) {
      try {
        const data = await fetchJSON(ep.searchUrl(query, limit), 12000);
        const results = ep.parseSearch(data).filter(s => s.id && s.title);
        if (results.length > 0) {
          endpointStatus[ep.name] = 'up';
          console.log(`[JioSaavn search] ✓ ${ep.name} → ${results.length} resultados para "${query}"`);
          return results;
        }
      } catch (e) {
        console.warn(`[JioSaavn search] ✗ ${ep.name}:`, e.message);
        endpointStatus[ep.name] = 'down';
        // Resetear después de 5 min para reintentar
        setTimeout(() => { delete endpointStatus[ep.name]; }, 300000);
      }
    }
  }
  return [];
}

async function jiosaavnStreamUrl(trackId) {
  const realId = trackId.replace('jsv_', '');
  for (const ep of JSV_ENDPOINTS) {
    try {
      const data = await fetchJSON(ep.songUrl(realId), 12000);
      const url = ep.parseStream(data);
      if (url) {
        console.log(`[JioSaavn stream] ✓ ${ep.name}`);
        return url;
      }
    } catch (e) {
      console.warn(`[JioSaavn stream] ✗ ${ep.name}:`, e.message);
    }
  }
  throw new Error('JioSaavn: ningún endpoint devolvió URL de stream');
}

// ─── YouTube search via yt-dlp (SOLO para búsqueda como fallback) ─────────────
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
    // NOTA: Estos resultados de YouTube NO se pueden streamear sin cookies,
    // los filtramos marcándolos como 'youtube_no_stream' para que el cliente
    // sepa que no puede reproducirlos directamente.
    // Por ahora los devolvemos solo si JioSaavn está completamente caído.
    return raw.split('\n').filter(Boolean).map(line => {
      try {
        const d = JSON.parse(line);
        if (!d.id || d.id.length !== 11) return null;
        return {
          id: d.id,
          title: d.title || '',
          artist: d.uploader || d.channel || '',
          duration: d.duration || 0,
          durationStr: fmt(d.duration),
          thumbnail: d.thumbnail || `https://img.youtube.com/vi/${d.id}/mqdefault.jpg`,
          source: 'youtube',
          unavailable: true, // marca como no reproducible
        };
      } catch { return null; }
    }).filter(Boolean);
  } catch (e) {
    console.warn('[yt-dlp search]', String(e).substring(0, 100));
    return [];
  }
}

// ─── ffmpeg pipe ──────────────────────────────────────────────────────────────
function pipeAudio(audioUrl, res, req, extraArgs = []) {
  const ff = spawn(ffmpegBin, [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    ...extraArgs, '-i', audioUrl,
    '-vn', '-ar', '44100', '-ac', '2', '-b:a', '128k', '-f', 'mp3', 'pipe:1',
  ]);
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  ff.stdout.pipe(res);
  ff.stderr.on('data', () => {});
  req.on('close', () => { try { ff.kill('SIGKILL'); } catch (_) {} });
  ff.on('error', (e) => {
    console.error('[ffmpeg error]', e.message);
    if (!res.headersSent) res.status(500).end();
  });
  ff.on('close', code => {
    if (code !== 0 && !res.headersSent) res.status(500).end();
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({
  status: 'ok',
  message: 'Aletone API v6 - JioSaavn Only',
  cookiesLoaded: fs.existsSync(COOKIES_FILE),
  cookieBytes: fs.existsSync(COOKIES_FILE) ? fs.statSync(COOKIES_FILE).size : 0,
  endpointStatus,
}));

// ── /api/search ───────────────────────────────────────────────────────────────
// Primero JioSaavn. Si falla completamente, intenta yt-dlp como fallback de búsqueda
// pero marca esos resultados como no reproducibles.
app.get('/api/search', async (req, res) => {
  const { q, limit = 15 } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta parámetro q' });

  console.log(`[Search] Buscando: "${q}"`);

  const jsv = await jiosaavnSearch(q, Number(limit));
  if (jsv.length > 0) {
    return res.json({ results: jsv, source: 'jiosaavn' });
  }

  // Fallback: yt-dlp search (resultados marcados como unavailable)
  console.warn('[Search] JioSaavn completamente caído, intentando yt-dlp search...');
  const yt = await ytdlpSearch(q, Number(limit));
  if (yt.length > 0) {
    return res.json({ results: yt, source: 'youtube_search_only', warning: 'Streaming de YouTube no disponible sin cookies' });
  }

  res.status(503).json({ error: 'Todos los servicios de búsqueda están caídos. Reintenta en unos minutos.' });
});

// ── /api/stream/:videoId ──────────────────────────────────────────────────────
// Solo JioSaavn. YouTube removido (requiere cookies en Render).
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;

  if (!videoId.startsWith('jsv_')) {
    return res.status(400).json({
      error: 'Solo se admiten IDs de JioSaavn (jsv_*). El streaming de YouTube no está disponible.',
    });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    const audioUrl = await jiosaavnStreamUrl(videoId);
    console.log('[Stream] JioSaavn OK →', audioUrl.substring(0, 60) + '...');
    pipeAudio(audioUrl, res, req);
  } catch (e) {
    console.error('[Stream] Error:', e.message);
    if (!res.headersSent) res.status(503).json({ error: 'No se pudo obtener el stream: ' + e.message });
  }
});

// ── /api/stream-url/:videoId ──────────────────────────────────────────────────
// Devuelve la URL directa de JioSaavn (para que el cliente la use directamente)
app.get('/api/stream-url/:videoId', async (req, res) => {
  const { videoId } = req.params;
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!videoId.startsWith('jsv_')) {
    return res.status(400).json({ error: 'Solo IDs de JioSaavn' });
  }

  try {
    const url = await jiosaavnStreamUrl(videoId);
    res.json({ url });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// ── /api/download ─────────────────────────────────────────────────────────────
app.post('/api/download', async (req, res) => {
  const { videoId, title } = req.body;
  if (!videoId) return res.status(400).json({ error: 'Falta videoId' });
  if (!videoId.startsWith('jsv_')) {
    return res.status(400).json({ error: 'Solo se pueden descargar canciones de JioSaavn' });
  }

  const filename = sanitize(title || videoId) + '.mp3';
  const filepath = path.join(DOWNLOADS_DIR, filename);

  if (fs.existsSync(filepath)) {
    return res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });
  }

  try {
    const audioUrl = await jiosaavnStreamUrl(videoId);
    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegBin, [
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-i', audioUrl, '-vn', '-ar', '44100', '-ac', '2', '-b:a', '192k', filepath,
      ]);
      ff.stderr.on('data', () => {});
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
      ff.on('error', reject);
    });
    res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });
  } catch (err) {
    console.error('[Download] Error:', err);
    res.status(500).json({ error: 'Download failed', detail: String(err).substring(0, 300) });
  }
});

// ── /api/health ───────────────────────────────────────────────────────────────
// Prueba todos los endpoints de JioSaavn y reporta cuáles funcionan
app.get('/api/health', async (req, res) => {
  const results = await Promise.allSettled(
    JSV_ENDPOINTS.map(async ep => {
      const start = Date.now();
      try {
        const data = await fetchJSON(ep.searchUrl('test', 1), 8000);
        const items = ep.parseSearch(data);
        return { name: ep.name, ok: true, ms: Date.now() - start, items: items.length };
      } catch (e) {
        return { name: ep.name, ok: false, ms: Date.now() - start, error: e.message };
      }
    })
  );
  res.json({
    endpoints: results.map(r => r.value || r.reason),
    timestamp: new Date().toISOString(),
  });
});

// Cleanup archivos viejos
setInterval(() => {
  try {
    const now = Date.now();
    fs.readdirSync(DOWNLOADS_DIR).forEach(f => {
      const fp = path.join(DOWNLOADS_DIR, f);
      if (now - fs.statSync(fp).mtimeMs > 86400000) fs.unlinkSync(fp);
    });
  } catch (_) {}
}, 3600000);

app.listen(PORT, () => console.log(`Aletone API v6 en puerto ${PORT}`));