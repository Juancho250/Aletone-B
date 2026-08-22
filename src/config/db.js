const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const db = {
  query: (text, params) => pool.query(text, params),
  one: async (text, params) => {
    const result = await pool.query(text, params);
    return result.rows[0] ?? null;
  },
  all: async (text, params) => {
    const result = await pool.query(text, params);
    return result.rows;
  },
};

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

    CREATE TABLE IF NOT EXISTS devices (
      id           BIGSERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_key   TEXT NOT NULL,
      name         TEXT NOT NULL,
      device_type  TEXT NOT NULL DEFAULT 'browser',
      capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
      state        JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, device_key)
    );

    CREATE TABLE IF NOT EXISTS device_commands (
      id               BIGSERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_device_id BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      sender_device_id BIGINT REFERENCES devices(id) ON DELETE SET NULL,
      command          TEXT NOT NULL,
      payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      consumed_at      TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id);
    CREATE INDEX IF NOT EXISTS idx_history_played ON history(played_at DESC);
    CREATE INDEX IF NOT EXISTS idx_playlist_user ON playlists(user_id);
    CREATE INDEX IF NOT EXISTS idx_devices_user_seen ON devices(user_id, last_seen DESC);
    CREATE INDEX IF NOT EXISTS idx_device_commands_pending ON device_commands(target_device_id, consumed_at, created_at);
  `);
  console.log('[DB] Tablas listas');
}

module.exports = { db, initDB };
