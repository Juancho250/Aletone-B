const { spawn } = require('child_process');
const ffmpegBin = require('ffmpeg-static');

const BASE_ARGS = [
  '-reconnect', '1',
  '-reconnect_streamed', '1',
  '-reconnect_delay_max', '5',
];

/**
 * Hace proxy del audio directamente al response (streaming en tiempo real)
 */
function pipeAudio(audioUrl, res, req) {
  const ff = spawn(ffmpegBin, [
    ...BASE_ARGS,
    '-i', audioUrl,
    '-vn', '-ar', '44100', '-ac', '2', '-b:a', '128k',
    '-f', 'mp3', 'pipe:1',
  ]);

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  ff.stdout.pipe(res);
  ff.stderr.on('data', () => {}); // silenciar logs de ffmpeg

  req.on('close', () => { try { ff.kill('SIGKILL'); } catch (_) {} });
  ff.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  ff.on('close', (code) => { if (code !== 0 && !res.headersSent) res.status(500).end(); });
}

/**
 * Descarga y guarda el audio en disco como MP3 a 192kbps
 */
function downloadAudio(audioUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegBin, [
      ...BASE_ARGS,
      '-i', audioUrl,
      '-vn', '-ar', '44100', '-ac', '2', '-b:a', '192k',
      outputPath,
    ]);
    ff.stderr.on('data', () => {});
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg salió con código ${code}`))));
    ff.on('error', reject);
  });
}

module.exports = { pipeAudio, downloadAudio };