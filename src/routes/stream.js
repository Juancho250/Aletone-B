const fs = require('fs');
const path = require('path');
const router = require('express').Router();
const { scStreamUrl } = require('../services/soundcloud');
const { deezerTrackUrl } = require('../services/deezer');
const { pipeAudio, downloadAudio } = require('../services/ffmpeg');
const { sanitize } = require('../utils/helpers');

const DOWNLOADS_DIR = path.join(__dirname, '../../downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

setInterval(() => {
  try {
    const now = Date.now();
    fs.readdirSync(DOWNLOADS_DIR).forEach((f) => {
      const fp = path.join(DOWNLOADS_DIR, f);
      if (now - fs.statSync(fp).mtimeMs > 86400000) fs.unlinkSync(fp);
    });
  } catch (_) {}
}, 3600000);

async function resolveAudioUrl(trackId) {
  if (trackId.startsWith('sc_')) return scStreamUrl(trackId);
  if (trackId.startsWith('dz_')) return deezerTrackUrl(trackId);
  throw new Error('ID inválido. Usa prefijo sc_ o dz_');
}

// ✅ 1. PRIMERO: rutas específicas con prefijo fijo

// GET /api/stream/url/:trackId — devuelve la URL directa sin proxy
router.get('/url/:trackId', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const url = await resolveAudioUrl(req.params.trackId);
    res.json({ url });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// POST /api/stream/download
router.post('/download', async (req, res) => {
  const { videoId, title, streamUrl: directUrl } = req.body;
  if (!videoId) return res.status(400).json({ error: 'Falta videoId' });

  const filename = sanitize(title || videoId) + '.mp3';
  const filepath = path.join(DOWNLOADS_DIR, filename);

  if (fs.existsSync(filepath))
    return res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });

  try {
    const audioUrl = directUrl || (await resolveAudioUrl(videoId));
    await downloadAudio(audioUrl, filepath);
    res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });
  } catch (err) {
    res.status(500).json({ error: 'Download failed', detail: String(err).substring(0, 200) });
  }
});

// ✅ 2. AL FINAL: la ruta genérica /:trackId (proxy de audio)
router.get('/:trackId', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  try {
    const audioUrl = await resolveAudioUrl(req.params.trackId);
    pipeAudio(audioUrl, res, req);
  } catch (e) {
    console.error('[stream]', e.message);
    if (!res.headersSent) res.status(503).json({ error: e.message });
  }
});

module.exports = router;