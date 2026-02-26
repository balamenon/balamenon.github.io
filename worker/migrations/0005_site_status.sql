CREATE TABLE IF NOT EXISTS site_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status_text TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO site_status (id, status_text)
VALUES (1, NULL);
