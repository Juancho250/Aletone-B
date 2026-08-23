const { fmt, fetchJSON } = require('../utils/helpers');

const BASE = 'https://api.deezer.com';
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map();

function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function trackFrom(item) {
  if (!item?.id) return null;
  return {
    catalogId: `dz_${item.id}`,
    externalId: String(item.id),
    title: item.title || '',
    titleShort: item.title_short || item.title || '',
    artist: item.artist?.name || '',
    artistId: item.artist?.id ? String(item.artist.id) : '',
    album: item.album?.title || '',
    albumId: item.album?.id ? String(item.album.id) : '',
    thumbnail: item.album?.cover_xl || item.album?.cover_big || item.album?.cover_medium || item.album?.cover || '',
    duration: Number(item.duration || 0),
    durationStr: fmt(Number(item.duration || 0)),
    rank: Number(item.rank || 0),
    explicit: Boolean(item.explicit_lyrics),
    previewUrl: item.preview || null,
    source: 'deezer-catalog',
    playable: false,
  };
}

function artistFrom(track) {
  if (!track?.artist) return null;
  return {
    id: track.artistId || `artist:${fold(track.artist)}`,
    name: track.artist,
    thumbnail: track.thumbnail || '',
    type: 'artist',
  };
}

function albumFrom(track) {
  if (!track?.album) return null;
  return {
    id: track.albumId || `album:${fold(track.artist)}:${fold(track.album)}`,
    title: track.album,
    artist: track.artist,
    thumbnail: track.thumbnail || '',
    type: 'album',
  };
}

async function searchCatalog(query, limit = 30) {
  const clean = String(query || '').trim().replace(/\s+/g, ' ').slice(0, 180);
  if (!clean) return { tracks: [], artists: [], albums: [] };
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 50);
  const key = `${fold(clean)}|${safeLimit}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const data = await fetchJSON(`${BASE}/search?q=${encodeURIComponent(clean)}&limit=${safeLimit}&output=json`);
  const tracks = (data.data || []).map(trackFrom).filter(Boolean);
  const artistMap = new Map();
  const albumMap = new Map();
  for (const track of tracks) {
    const artist = artistFrom(track);
    if (artist) {
      const akey = fold(artist.name);
      if (!artistMap.has(akey)) artistMap.set(akey, artist);
    }
    const album = albumFrom(track);
    if (album) {
      const akey = `${fold(album.artist)}|${fold(album.title)}`;
      if (!albumMap.has(akey)) albumMap.set(akey, album);
    }
  }

  const value = {
    tracks,
    artists: [...artistMap.values()].slice(0, 10),
    albums: [...albumMap.values()].slice(0, 12),
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

function suggestionScore(value, query, type, popularity = 0) {
  const text = fold(value);
  const q = fold(query);
  let score = 0;
  if (text === q) score += 500;
  else if (text.startsWith(q)) score += 330;
  else if (text.includes(q)) score += 220;
  else if (q.includes(text) && text.length >= 3) score += 160;
  if (type === 'track') score += 45;
  if (type === 'artist') score += 30;
  score += Math.min(40, Math.log10(Math.max(0, Number(popularity || 0)) + 1) * 5);
  return score;
}

async function searchSuggestions(query, limit = 8) {
  const result = await searchCatalog(query, Math.max(18, limit * 3));
  const rows = [];

  result.tracks.slice(0, 12).forEach(item => rows.push({
    type: 'track',
    value: item.title,
    subtitle: item.artist || 'Canción',
    thumbnail: item.thumbnail || '',
    score: suggestionScore(item.titleShort || item.title, query, 'track', item.rank),
  }));
  result.artists.slice(0, 8).forEach(item => rows.push({
    type: 'artist',
    value: item.name,
    subtitle: 'Artista',
    thumbnail: item.thumbnail || '',
    score: suggestionScore(item.name, query, 'artist'),
  }));
  result.albums.slice(0, 8).forEach(item => rows.push({
    type: 'album',
    value: item.title,
    subtitle: item.artist || 'Álbum',
    thumbnail: item.thumbnail || '',
    score: suggestionScore(item.title, query, 'album'),
  }));

  const seen = new Set();
  return rows
    .sort((a, b) => b.score - a.score)
    .filter(item => {
      const key = `${item.type}|${fold(item.value)}|${fold(item.subtitle)}`;
      if (!item.value || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map(({ score, ...item }) => item);
}

module.exports = { BASE, fold, searchCatalog, searchSuggestions };
