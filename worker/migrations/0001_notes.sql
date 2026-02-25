CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  word_count INTEGER NOT NULL CHECK (word_count >= 0),
  source TEXT NOT NULL DEFAULT 'telegram',
  source_message_id TEXT,
  source_chat_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC);

CREATE TABLE IF NOT EXISTS telegram_sessions (
  user_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  selected_note_id INTEGER,
  pending_content TEXT,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
