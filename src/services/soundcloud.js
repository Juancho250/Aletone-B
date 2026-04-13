const { fmt, fetchJSON } = require('../utils/helpers');

let scClientId = null;
let scClientIdFetchedAt = 0;
const CACHE_MS = 60 * 60 * 1000; // renueva cada hora

async function getSCClientId() {
  if (scClientId && Date.now() - scClientIdFetchedAt < CACHE_MS) return scClientId;

  console.log('[SC] Obteniendo client_id...');
  const html = await (
    await fetch('https://soundcloud.com', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      },
    })
  ).text();

  const scriptUrls = [
    ...html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js/g),
  ].map((m) => m[0]);

  for (const scriptUrl of scriptUrls.slice(-5)) {
    try {
      const js = await (await fetch(scriptUrl)).text();
      const match = js.match(/client_id\s*:\s*"([a-zA-Z0-9]{32})"/);
      if (match) {
        scClientId = match[1];
        scClientIdFetchedAt = Date.now();
        console.log('[SC] client_id ok:', scClientId.substring(0, 8) + '...');
        return scClientId;
      }
    } catch (_) {}
  }
  throw new Error('SoundCloud: client_id no encontrado en scripts');
}

async function scSearch(q, limit = 15) {
  const cid = await getSCClientId();
  const data = await fetchJSON(
    `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&client_id=${cid}&limit=${limit}&app_locale=en`
  );
  return (data.collection || [])
    .map((t) => ({
      id: `sc_${t.id}`,
      title: t.title || '',
      artist: t.user?.username || '',
      duration: Math.floor((t.duration || 0) / 1000),
      durationStr: fmt(Math.floor((t.duration || 0) / 1000)),
      thumbnail: (t.artwork_url || t.user?.avatar_url || '').replace('large', 't300x300'),
      source: 'soundcloud',
      permalink: t.permalink_url,
      streamable: t.streamable !== false,
    }))
    .filter((t) => t.streamable);
}

async function scStreamUrl(trackId) {
  const cid = await getSCClientId();
  const rawId = trackId.replace('sc_', '');
  const data = await fetchJSON(
    `https://api-v2.soundcloud.com/tracks/${rawId}?client_id=${cid}`
  );
  const transcodings = data?.media?.transcodings || [];
  const progressive = transcodings.find(
    (t) => t.format?.protocol === 'progressive' && t.format?.mime_type === 'audio/mpeg'
  );
  const hls = transcodings.find(
    (t) => t.format?.protocol === 'hls' && t.format?.mime_type === 'audio/mpeg'
  );
  const transcoding = progressive || hls;
  if (!transcoding?.url) throw new Error('SoundCloud: no transcodings disponibles');
  const resolved = await fetchJSON(`${transcoding.url}?client_id=${cid}`);
  if (!resolved?.url) throw new Error('SoundCloud: URL no resuelta');
  return resolved.url;
}

module.exports = { getSCClientId, scSearch, scStreamUrl };