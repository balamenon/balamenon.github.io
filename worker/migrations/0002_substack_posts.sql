CREATE TABLE IF NOT EXISTS substack_posts (
  rank INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  description TEXT NOT NULL,
  pub_date TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_substack_posts_rank ON substack_posts(rank);
