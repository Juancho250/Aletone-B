const { execSync } = require('child_process');
const crypto = require('crypto');
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
} catch (e) { console.error('yt-dlp setup error:', e.message); }

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

// ─── Utils ────────────────────────────────────────────────────────────────────
function fmt(s) {
  if (!s) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function sanitize(n) {
  return (n || 'track').replace(/[^a-z0-9\-_. ]/gi, '_').substring(0, 100);
}

// JioSaavn encripta URLs con DES-ECB, key = "38346591"
// La URL resultante termina en _96.mp4 (96kbps) → la subimos a _320.mp4
function decryptJioSaavnUrl(encrypted) {
  if (!encrypted) return null;
  try {
    const key = Buffer.from('38346591');
    const decipher = crypto.createDecipheriv('des-ecb', key, null);
    decipher.setAutoPadding(true);
    const data = Buffer.from(encrypted, 'base64');
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8')
      .replace('http://', 'https://')
      .replace('_96.mp4', '_320.mp4'); // máxima calidad disponible
  } catch (e) {
    console.warn('[DES decrypt] failed:', e.message);
    return null;
  }
}

// Intenta obtener la mejor URL de stream de una canción de los resultados de la API
function extractStreamUrl(song) {
  // Opción 1: downloadUrl directo (algunas APIs lo incluyen)
  if (Array.isArray(song.downloadUrl) && song.downloadUrl.length > 0) {
    const url = [...song.downloadUrl].reverse().find(u => u?.url)?.url;
    if (url) return url;
  }
  // Opción 2: media_preview_url o similar directo
  if (song.media_preview_url && song.media_preview_url.startsWith('http')) {
    return song.media_preview_url.replace('_96.mp4', '_320.mp4').replace('http://', 'https://');
  }
  // Opción 3: encrypted_media_url → desencriptar
  const enc = song.encrypted_media_url || song.more_info?.encrypted_media_url;
  if (enc) return decryptJioSaavnUrl(enc);

  return null;
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
const JSV_ENDPOINTS = [
  {
    name: 'jiosaavn-api-2',
    // Este endpoint devuelve more_info.encrypted_media_url en los resultados
    searchUrl: (q, limit) =>
      `https://jiosaavn-api-2.vercel.app/search/songs?query=${encodeURIComponent(q)}&page=1&limit=${limit}`,
    songUrl: (id) =>
      `https://jiosaavn-api-2.vercel.app/songs?id=${encodeURIComponent(id)}`,
    parseSearch: (data) => {
      const items = data?.data?.results || data?.results || [];
      return items.map(s => {
        const rawId = s.id || s.songid;
        return {
          id: `jsv_${rawId}`,
          rawId,
          title: s.title || s.name || '',
          artist: s.more_info?.singers || s.subtitle || (s.artists?.primary||[]).map(a=>a.name).join(', ') || '',
          duration: parseInt(s.more_info?.duration || s.duration) || 0,
          durationStr: fmt(parseInt(s.more_info?.duration || s.duration) || 0),
          thumbnail: s.image?.replace('150x150', '500x500') || '',
          source: 'jiosaavn',
          streamUrl: extractStreamUrl({ ...s, ...s.more_info }),
        };
      });
    },
    parseStream: (data) => {
      const song = Array.isArray(data) ? data[0] : (data?.data?.[0] || data?.[0] || data);
      return extractStreamUrl({ ...song, ...song?.more_info });
    },
  },
  {
    name: 'saavn.dev',
    searchUrl: (q, limit) =>
      `https://saavn.dev/api/search/songs?query=${encodeURIComponent(q)}&page=1&limit=${limit}`,
    songUrl: (id) =>
      `https://saavn.dev/api/songs/${id}`,
    parseSearch: (data) => {
      const items = data?.data?.results || [];
      return items.map(s => ({
        id: `jsv_${s.id}`,
        rawId: s.id,
        title: s.name || '',
        artist: (s.artists?.primary || []).map(a => a.name).join(', ') || '',
        duration: s.duration || 0,
        durationStr: fmt(s.duration),
        thumbnail: s.image?.[2]?.url || s.image?.[1]?.url || '',
        source: 'jiosaavn',
        streamUrl: extractStreamUrl(s),
      }));
    },
    parseStream: (data) => {
      const song = data?.data?.[0];
      return extractStreamUrl(song || {});
    },
  },
  {
    name: 'jiosaavn-api-privatecvc2',
    searchUrl: (q, limit) =>
      `https://jiosaavn-api-privatecvc2.vercel.app/api/search/songs?query=${encodeURIComponent(q)}&page=1&limit=${limit}`,
    songUrl: (id) =>
      `https://jiosaavn-api-privatecvc2.vercel.app/api/songs/${id}`,
    parseSearch: (data) => {
      const items = data?.data?.results || [];
      return items.map(s => ({
        id: `jsv_${s.id}`,
        rawId: s.id,
        title: s.name || '',
        artist: (s.artists?.primary || []).map(a => a.name).join(', ') || '',
        duration: s.duration || 0,
        durationStr: fmt(s.duration),
        thumbnail: s.image?.[2]?.url || s.image?.[1]?.url || '',
        source: 'jiosaavn',
        streamUrl: extractStreamUrl(s),
      }));
    },
    parseStream: (data) => {
      const song = data?.data?.[0];
      return extractStreamUrl(song || {});
    },
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
  // Intenta los endpoints con song detail
  for (const ep of JSV_ENDPOINTS) {
    try {
      const rawId = trackId.replace('jsv_', '');
      const data = await fetchJSON(ep.songUrl(rawId));
      const url = ep.parseStream(data);
      if (url) {
        console.log(`[StreamURL] ✓ ${ep.name}: ${url.substring(0, 50)}...`);
        return url;
      }
    } catch (e) {
      console.warn(`[StreamURL] ✗ ${ep.name}:`, e.message);
    }
  }
  throw new Error('Ningún endpoint devolvió URL de stream');
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
app.get('/', (_req, res) => res.json({ status: 'ok', message: 'Aletone API v8' }));

// TEST de desencriptado (diagnóstico)
app.get('/api/test-decrypt', async (_req, res) => {
  try {
    const data = await fetchJSON(
      'https://jiosaavn-api-2.vercel.app/search/songs?query=arijit+singh&page=1&limit=3',
      10000
    );
    const items = data?.data?.results || data?.results || [];
    const debug = items.map(s => ({
      title: s.title || s.name,
      has_downloadUrl: !!(s.downloadUrl),
      has_encrypted: !!(s.encrypted_media_url || s.more_info?.encrypted_media_url),
      encrypted_preview: (s.encrypted_media_url || s.more_info?.encrypted_media_url || '').substring(0, 30),
      decrypted: extractStreamUrl({ ...s, ...s.more_info }),
      raw_keys: Object.keys(s),
      more_info_keys: s.more_info ? Object.keys(s.more_info) : [],
    }));
    res.json({ items: debug, rawFirst: items[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// BÚSQUEDA
app.get('/api/search', async (req, res) => {
  const { q, limit = 15 } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta q' });
  console.log(`[Search] "${q}"`);
  const results = await jiosaavnSearch(q, Number(limit));
  if (results.length > 0) return res.json({ results, source: 'jiosaavn' });
  res.status(503).json({ error: 'JioSaavn no disponible. Intenta de nuevo.' });
});

// PROXY STREAM (fallback cuando streamUrl directa falla por CORS)
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

// STREAM-URL (URL fresca cuando la del search expiró)
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

// HEALTH
app.get('/api/health', async (_req, res) => {
  const results = await Promise.allSettled(JSV_ENDPOINTS.map(async ep => {
    const t = Date.now();
    try {
      const data = await fetchJSON(ep.searchUrl('arijit singh', 3), 8000);
      const items = ep.parseSearch(data).filter(s => s.id && s.title);
      return { name: ep.name, ok: true, ms: Date.now()-t, songs: items.length, withStreamUrl: items.filter(s=>s.streamUrl).length };
    } catch (e) {
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

app.listen(PORT, () => console.log(`Aletone API v8 en puerto ${PORT}`));