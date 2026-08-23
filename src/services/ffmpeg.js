const { spawn } = require('child_process');
const ffmpegBin = require('ffmpeg-static');

const BASE_ARGS = [
  '-hide_banner',
  '-loglevel', 'error',
  '-reconnect', '1',
  '-reconnect_streamed', '1',
  '-reconnect_delay_max', '3',
];

const LOW_LATENCY_INPUT_ARGS = [
  '-fflags', 'nobuffer',
  '-probesize', '32768',
  '-analyzeduration', '100000',
];

/**
 * Proxy de audio orientado a tiempo de arranque. Para HLS no esperamos a analizar
 * varios segundos de contenido antes de producir el primer frame MP3.
 */
function pipeAudio(audioUrl, res, req) {
  const ff = spawn(ffmpegBin, [
    ...BASE_ARGS,
    ...LOW_LATENCY_INPUT_ARGS,
    '-i', audioUrl,
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    '-f', 'mp3',
    '-flush_packets', '1',
    'pipe:1',
  ]);

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  ff.stdout.pipe(res);
  ff.stderr.on('data', () => {});

  const stop = () => { try { ff.kill('SIGKILL'); } catch (_) {} };
  req.on('close', stop);
  req.on('aborted', stop);
  ff.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  ff.on('close', (code) => { if (code !== 0 && !res.headersSent) res.status(500).end(); });
}

/**
 * Descarga y guarda el audio en disco como MP3 a 192kbps.
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