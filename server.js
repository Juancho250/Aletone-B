// Agregar al inicio, antes de todo
const ffmpegPath = require('ffmpeg-static');
process.env.PATH = `${require('path').dirname(ffmpegPath)}:${process.env.PATH}`;

const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(DOWNLOADS_DIR));

// ─── Utilidades ───────────────────────────────────────────────────────────────

function ytdlp(args) {
  return new Promise((resolve, reject) => {
    const cmd = `yt-dlp ${args}`;
    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout.trim());
    });
  });
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9\-_. ]/gi, '_').substring(0, 100);
}

// ─── Rutas ────────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', message: 'MusiCloud API' }));

// Buscar canciones (YouTube Music)
app.get('/api/search', async (req, res) => {
  const { q, limit = 10 } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta el parámetro q' });

  try {
    const raw = await ytdlp(
      `"ytsearch${limit}:${q}" --dump-json --no-playlist --flat-playlist --no-warnings`
    );

    const results = raw
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          const d = JSON.parse(line);
          return {
            id: d.id,
            title: d.title,
            artist: d.uploader || d.channel || '',
            duration: d.duration,
            durationStr: formatDuration(d.duration),
            thumbnail: d.thumbnail ||
              `https://img.youtube.com/vi/${d.id}/mqdefault.jpg`,
            url: `https://www.youtube.com/watch?v=${d.id}`,
          };
        } catch { return null; }
      })
      .filter(Boolean);

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Error al buscar', detail: String(err) });
  }
});

// Stream de audio directo (sin descargar al servidor)
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const audioUrl = await ytdlp(
      `"${url}" -f bestaudio --get-url --no-warnings`
    );

    if (!audioUrl) return res.status(404).json({ error: 'No se encontró audio' });

    // Proxy del stream para evitar problemas de CORS
    const proto = audioUrl.startsWith('https') ? https : http;
    const proxyReq = proto.get(audioUrl, (proxyRes) => {
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'audio/webm');
      res.setHeader('Accept-Ranges', 'bytes');
      if (proxyRes.headers['content-length']) {
        res.setHeader('Content-Length', proxyRes.headers['content-length']);
      }
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => res.status(500).json({ error: 'Error en stream' }));

  } catch (err) {
    res.status(500).json({ error: 'Error al obtener stream', detail: String(err) });
  }
});

// Descargar canción como MP3 (la guarda en servidor y devuelve URL)
app.post('/api/download', async (req, res) => {
  const { videoId, title } = req.body;
  if (!videoId) return res.status(400).json({ error: 'Falta videoId' });

  const filename = sanitizeFilename(title || videoId) + '.mp3';
  const filepath = path.join(DOWNLOADS_DIR, filename);

  // Si ya existe, devolver directo
  if (fs.existsSync(filepath)) {
    return res.json({
      success: true,
      filename,
      url: `/downloads/${encodeURIComponent(filename)}`,
    });
  }

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    await ytdlp(
      `"${url}" -x --audio-format mp3 --audio-quality 0 -o "${filepath}" --no-warnings`
    );

    res.json({
      success: true,
      filename,
      url: `/downloads/${encodeURIComponent(filename)}`,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al descargar', detail: String(err) });
  }
});

// Info de canción individual
app.get('/api/info/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const raw = await ytdlp(
      `"https://www.youtube.com/watch?v=${videoId}" --dump-json --no-warnings`
    );
    const d = JSON.parse(raw);
    res.json({
      id: d.id,
      title: d.title,
      artist: d.uploader || d.channel || '',
      duration: d.duration,
      durationStr: formatDuration(d.duration),
      thumbnail: d.thumbnail,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener info', detail: String(err) });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Limpieza de archivos viejos (cada hora, borra +24h) ──────────────────────
setInterval(() => {
  const now = Date.now();
  fs.readdirSync(DOWNLOADS_DIR).forEach(f => {
    const fp = path.join(DOWNLOADS_DIR, f);
    const stat = fs.statSync(fp);
    if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(fp);
  });
}, 60 * 60 * 1000);

app.listen(PORT, () => console.log(`MusiCloud API corriendo en puerto ${PORT}`));
