const fs = require('fs');
const path = require('path');
const router = require('express').Router();
const { scStreamUrl } = require('../services/soundcloud');
const { deezerTrackUrl } = require('../services/deezer');
const { pipeAudio, downloadAudio } = require('../services/ffmpeg');
const { sanitize } = require('../utils/helpers');

const DOWNLOADS_DIR = path.join(__dirname, '../../downloads');
const TRACK_ID_RE = /^(?:sc|dz)_[A-Za-z0-9_-]{1,180}$/;
const ONE_DAY_MS = 86_400_000;
const cleanupTimer = setInterval(cleanOldDownloads, 3_600_000);
cleanupTimer.unref?.();

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

function assertTrackId(trackId) {
  if (!TRACK_ID_RE.test(String(trackId || ''))) {
    const error = new Error('ID de pista inválido');
    error.status = 400;
    throw error;
  }
  return trackId;
}

function cleanOldDownloads() {
  try {
    const now = Date.now();
    fs.readdirSync(DOWNLOADS_DIR).forEach(filename => {
      const filepath = path.join(DOWNLOADS_DIR, filename);
      if (now - fs.statSync(filepath).mtimeMs > ONE_DAY_MS) fs.unlinkSync(filepath);
    });
  } catch (error) {
    console.warn('[downloads] Limpieza omitida:', error.message);
  }
}

async function resolveAudioUrl(trackId) {
  assertTrackId(trackId);
  if (trackId.startsWith('sc_')) return scStreamUrl(trackId);
  return deezerTrackUrl(trackId);
}

function buildDownloadName(trackId, title) {
  const safeTitle = sanitize(title || 'aletone').slice(0, 90) || 'aletone';
  const safeId = sanitize(trackId).slice(0, 80) || 'track';
  return `${safeTitle}-${safeId}.mp3`;
}

// Devuelve una URL efímera resuelta por el servidor. Nunca acepta URLs arbitrarias
// del cliente: evita que este endpoint se convierta en un proxy hacia hosts internos.
router.get('/url/:trackId', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = await resolveAudioUrl(req.params.trackId);
    return res.json({ url });
  } catch (error) {
    return res.status(error.status || 503).json({ error: error.message });
  }
});

// Genera una copia temporal para que el frontend pueda guardarla en IndexedDB.
// La reproducción offline final ocurre en el dispositivo del usuario.
router.post('/download', async (req, res) => {
  const { videoId, title } = req.body || {};

  try {
    assertTrackId(videoId);
    const filename = buildDownloadName(videoId, title);
    const filepath = path.join(DOWNLOADS_DIR, filename);

    if (fs.existsSync(filepath)) {
      return res.json({
        success: true,
        filename,
        url: `/downloads/${encodeURIComponent(filename)}`,
        cached: true,
      });
    }

    const audioUrl = await resolveAudioUrl(videoId);
    await downloadAudio(audioUrl, filepath);

    return res.json({
      success: true,
      filename,
      url: `/downloads/${encodeURIComponent(filename)}`,
      cached: false,
    });
  } catch (error) {
    console.error('[download]', error.message);
    return res.status(error.status || 500).json({
      error: error.status === 400 ? error.message : 'No fue posible preparar la descarga',
    });
  }
});

// Proxy de audio para navegadores/proveedores donde la URL directa no funciona.
router.get('/:trackId', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const audioUrl = await resolveAudioUrl(req.params.trackId);
    return pipeAudio(audioUrl, res, req);
  } catch (error) {
    console.error('[stream]', error.message);
    if (!res.headersSent) return res.status(error.status || 503).json({ error: error.message });
    return undefined;
  }
});

module.exports = router;
