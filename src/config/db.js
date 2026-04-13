const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requiere SSL
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Helpers para no repetir pool.query en cada ruta
const db = {
  query: (text, params) => pool.query(text, params),

  /** Devuelve la primera fila o null */
  one: async (text, params) => {
    const r = await pool.query(text, params);
    return r.rows[0] ?? null;
  },

  /** Devuelve todas las filas */
  all: async (text, params) => {
    const r = await pool.query(text, params);
    return r.rows;
  },
};

/** Crea las tablas si no existen — se llama al arrancar */
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   TEXT NOT NULL UNIQUE,
      email      TEXT NOT NULL UNIQUE,
      password   TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      cover      TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id          SERIAL PRIMARY KEY,
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      track_id    TEXT NOT NULL,
      title       TEXT,
      artist      TEXT,
      thumbnail   TEXT,
      source      TEXT,
      duration    INTEGER,
      added_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(playlist_id, track_id)
    );

    CREATE TABLE IF NOT EXISTS history (
      id        SERIAL PRIMARY KEY,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      track_id  TEXT NOT NULL,
      title     TEXT,
      artist    TEXT,
      thumbnail TEXT,
      source    TEXT,
      played_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_history_user   ON history(user_id);
    CREATE INDEX IF NOT EXISTS idx_history_played ON history(played_at DESC);
    CREATE INDEX IF NOT EXISTS idx_playlist_user  ON playlists(user_id);
  `);
  console.log('[DB] Tablas listas');
}

module.exports = { db, initDB };