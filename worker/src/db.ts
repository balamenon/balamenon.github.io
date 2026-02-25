import type { NoteRecord } from "./logic";

export type SessionState = "awaiting_edit_text" | "awaiting_newnote_truncate_confirm" | "awaiting_edit_truncate_confirm";

export type TelegramSession = {
  user_id: string;
  state: SessionState;
  selected_note_id: number | null;
  pending_content: string | null;
  expires_at: string;
};

type NoteRow = {
  id: number;
  content: string;
  word_count: number;
  created_at: string;
  updated_at: string;
};

type NoteThoughtRow = {
  id: number;
  content: string;
  created_at: string;
  source_message_id: string | null;
  source_chat_id: string | null;
};

type SubstackPostRow = {
  rank: number;
  title: string;
  link: string;
  description: string;
  pub_date: string;
  updated_at: string;
};

type SessionRow = {
  user_id: string;
  state: SessionState;
  selected_note_id: number | null;
  pending_content: string | null;
  expires_at: string;
};

export async function insertNote(
  db: D1Database,
  input: {
    content: string;
    wordCount: number;
    sourceMessageId?: string;
    sourceChatId?: string;
  },
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO notes (content, word_count, source, source_message_id, source_chat_id)
       VALUES (?, ?, 'telegram', ?, ?)`,
    )
    .bind(input.content, input.wordCount, input.sourceMessageId ?? null, input.sourceChatId ?? null)
    .run();

  return Number(result.meta.last_row_id);
}

export async function updateNote(db: D1Database, noteId: number, content: string, wordCount: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE notes
       SET content = ?, word_count = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       WHERE id = ?`,
    )
    .bind(content, wordCount, noteId)
    .run();

  return Number(result.meta.changes) > 0;
}

export async function deleteNote(db: D1Database, noteId: number): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM notes
       WHERE id = ?`,
    )
    .bind(noteId)
    .run();

  return Number(result.meta.changes) > 0;
}

export async function getAllNotes(db: D1Database): Promise<NoteRecord[]> {
  const result = await db
    .prepare(
      `SELECT id, content, word_count, created_at, updated_at
       FROM notes
       ORDER BY created_at DESC, id DESC`,
    )
    .all<NoteRow>();

  return (result.results ?? []).map((row) => ({
    id: Number(row.id),
    content: row.content,
    word_count: Number(row.word_count),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export async function getRecentNotes(db: D1Database, limit: number): Promise<NoteRecord[]> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const result = await db
    .prepare(
      `SELECT id, content, word_count, created_at, updated_at
       FROM notes
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(safeLimit)
    .all<NoteRow>();

  return (result.results ?? []).map((row) => ({
    id: Number(row.id),
    content: row.content,
    word_count: Number(row.word_count),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export type NoteThoughtTarget = {
  id: number;
  content: string;
  created_at: string;
  source_message_id: string | null;
  source_chat_id: string | null;
};

export async function getNoteThoughtTarget(db: D1Database, noteId: number): Promise<NoteThoughtTarget | null> {
  const row = await db
    .prepare(
      `SELECT id, content, created_at, source_message_id, source_chat_id
       FROM notes
       WHERE id = ?`,
    )
    .bind(noteId)
    .first<NoteThoughtRow>();

  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    content: row.content,
    created_at: row.created_at,
    source_message_id: row.source_message_id,
    source_chat_id: row.source_chat_id,
  };
}

export async function getSession(db: D1Database, userId: string): Promise<TelegramSession | null> {
  const row = await db
    .prepare(
      `SELECT user_id, state, selected_note_id, pending_content, expires_at
       FROM telegram_sessions
       WHERE user_id = ?`,
    )
    .bind(userId)
    .first<SessionRow>();

  if (!row) {
    return null;
  }

  if (Date.parse(row.expires_at) <= Date.now()) {
    await clearSession(db, userId);
    return null;
  }

  return {
    user_id: row.user_id,
    state: row.state,
    selected_note_id: row.selected_note_id === null ? null : Number(row.selected_note_id),
    pending_content: row.pending_content,
    expires_at: row.expires_at,
  };
}

export async function upsertSession(
  db: D1Database,
  input: {
    userId: string;
    state: SessionState;
    selectedNoteId?: number | null;
    pendingContent?: string | null;
    ttlMinutes?: number;
  },
): Promise<void> {
  const ttlMinutes = input.ttlMinutes ?? 30;
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();

  await db
    .prepare(
      `INSERT INTO telegram_sessions (user_id, state, selected_note_id, pending_content, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id)
       DO UPDATE SET
         state = excluded.state,
         selected_note_id = excluded.selected_note_id,
         pending_content = excluded.pending_content,
         expires_at = excluded.expires_at,
         updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    )
    .bind(input.userId, input.state, input.selectedNoteId ?? null, input.pendingContent ?? null, expiresAt)
    .run();
}

export async function clearSession(db: D1Database, userId: string): Promise<void> {
  await db.prepare(`DELETE FROM telegram_sessions WHERE user_id = ?`).bind(userId).run();
}

export type StoredSubstackPost = {
  rank: number;
  title: string;
  link: string;
  description: string;
  pub_date: string;
  updated_at: string;
};

export async function replaceSubstackPosts(
  db: D1Database,
  posts: Array<{ title: string; link: string; description: string; pub_date: string }>,
): Promise<void> {
  await db.batch([db.prepare(`DELETE FROM substack_posts`)]);

  if (!posts.length) {
    return;
  }

  const statements = posts.map((post, index) =>
    db
      .prepare(
        `INSERT INTO substack_posts (rank, title, link, description, pub_date)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(index + 1, post.title, post.link, post.description, post.pub_date),
  );

  await db.batch(statements);
}

export async function getSubstackPosts(db: D1Database, limit: number): Promise<StoredSubstackPost[]> {
  const safeLimit = Math.max(1, Math.min(limit, 20));
  const result = await db
    .prepare(
      `SELECT rank, title, link, description, pub_date, updated_at
       FROM substack_posts
       ORDER BY rank ASC
       LIMIT ?`,
    )
    .bind(safeLimit)
    .all<SubstackPostRow>();

  return (result.results ?? []).map((row) => ({
    rank: Number(row.rank),
    title: row.title,
    link: row.link,
    description: row.description,
    pub_date: row.pub_date,
    updated_at: row.updated_at,
  }));
}
