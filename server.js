const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const express = require('express');
const cors = require('cors');

// ─── Auto-instalar yt-dlp en carpeta local ───────────────────────────────────
const YTDLP_PATH = path.join(__dirname, 'yt-dlp');

if (!fs.existsSync(YTDLP_PATH)) {
  console.log('Instalando yt-dlp...');
  try {
    execSync(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${YTDLP_PATH}"`, { stdio: 'inherit' });
    execSync(`chmod a+rx "${YTDLP_PATH}"`, { stdio: 'inherit' });
    console.log('yt-dlp listo:', execSync(`"${YTDLP_PATH}" --version`).toString().trim());
  } catch(e) {
    console.error('Error instalando yt-dlp:', e.message);
  }
}

// ─── PATH con ffmpeg ─────────────────────────────────────────────────────────
const ffmpegPath = require('ffmpeg-static');
process.env.PATH = `${__dirname}:${path.dirname(ffmpegPath)}:${process.env.PATH}`;

// ─── Setup ───────────────────────────────────────────────────────────────────
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
    exec(`"${YTDLP_PATH}" ${args}`, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout.trim());
    });
  });
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9\-_. ]/gi, '_').substring(0, 100);
}

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Rutas ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'ok', message: 'MusiCloud API' }));

app.get('/api/search', async (req, res) => {
  const { q, limit = 10 } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta el parámetro q' });
  try {
    const raw = await ytdlp(
      `"ytsearch${limit}:${q}" --dump-json --no-playlist --flat-playlist --no-warnings`
    );
    const results = raw.split('\n').filter(Boolean).map(line => {
      try {
        const d = JSON.parse(line);
        // ✅ Filtrar: solo videos (tienen duration y ID corto de 11 chars)
        if (!d.id || d.id.length !== 11 || !d.duration) return null;
        return {
          id: d.id,
          title: d.title,
          artist: d.uploader || d.channel || '',
          duration: d.duration,
          durationStr: formatDuration(d.duration),
          thumbnail: d.thumbnail || `https://img.youtube.com/vi/${d.id}/mqdefault.jpg`,
          url: `https://www.youtube.com/watch?v=${d.id}`,
        };
      } catch { return null; }
    }).filter(Boolean);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Error al buscar', detail: String(err) });
  }
});

app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    // Obtener la URL directa del audio
    const audioUrl = await ytdlp(
      `"https://www.youtube.com/watch?v=${videoId}" -f bestaudio --get-url --no-warnings`
    );
    if (!audioUrl) return res.status(404).json({ error: 'No se encontró audio' });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');

    // Transcodificar con ffmpeg a MP3 compatible con todos los navegadores
    const ffmpegBin = require('ffmpeg-static');
    const { spawn } = require('child_process');

    const ff = spawn(ffmpegBin, [
      '-i', audioUrl,
      '-vn',              // sin video
      '-ar', '44100',     // sample rate estándar
      '-ac', '2',         // stereo
      '-b:a', '128k',     // bitrate
      '-f', 'mp3',        // formato mp3
      'pipe:1'            // output a stdout
    ]);

    ff.stdout.pipe(res);
    ff.stderr.on('data', () => {}); // ignorar logs de ffmpeg

    req.on('close', () => ff.kill('SIGKILL'));
    ff.on('error', (err) => {
      console.error('ffmpeg error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Error en stream' });
    });

  } catch (err) {
    res.status(500).json({ error: 'Error al obtener stream', detail: String(err) });
  }
});

app.post('/api/download', async (req, res) => {
  const { videoId, title } = req.body;
  if (!videoId) return res.status(400).json({ error: 'Falta videoId' });

  const filename = sanitizeFilename(title || videoId) + '.mp3';
  const filepath = path.join(DOWNLOADS_DIR, filename);

  if (fs.existsSync(filepath)) {
    return res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });
  }

  try {
    await ytdlp(
      `"https://www.youtube.com/watch?v=${videoId}" -x --audio-format mp3 --audio-quality 0 -o "${filepath}" --no-warnings`
    );
    res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });
  } catch (err) {
    res.status(500).json({ error: 'Error al descargar', detail: String(err) });
  }
});

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

// ─── Limpieza cada hora ───────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  fs.readdirSync(DOWNLOADS_DIR).forEach(f => {
    const fp = path.join(DOWNLOADS_DIR, f);
    if (now - fs.statSync(fp).mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(fp);
  });
}, 60 * 60 * 1000);

app.listen(PORT, () => console.log(`MusiCloud API corriendo en puerto ${PORT}`));