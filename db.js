const Database = require('better-sqlite3');
const fs = require('fs'), path = require('path');
const file = process.env.DB_PATH || path.join(__dirname, 'data', 'relacionamentos.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  relation_type TEXT,
  source_text TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'novo',      -- novo | aguardando | concluido
  questions TEXT,                            -- JSON
  answers TEXT,                              -- JSON
  report TEXT                                -- JSON
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  sent_at INTEGER NOT NULL,                  -- epoch ms
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_an ON messages(analysis_id, sent_at);
`);
module.exports = db;
