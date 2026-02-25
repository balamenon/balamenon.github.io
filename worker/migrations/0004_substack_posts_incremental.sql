CREATE TABLE IF NOT EXISTS substack_posts_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  link TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  pub_date TEXT NOT NULL,
  published_at INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO substack_posts_v2 (title, link, description, pub_date, published_at, updated_at)
SELECT title, link, description, pub_date, 0, updated_at
FROM substack_posts;

DROP TABLE substack_posts;
ALTER TABLE substack_posts_v2 RENAME TO substack_posts;

CREATE UNIQUE INDEX IF NOT EXISTS idx_substack_posts_link ON substack_posts(link);
CREATE INDEX IF NOT EXISTS idx_substack_posts_published_at ON substack_posts(published_at DESC);
