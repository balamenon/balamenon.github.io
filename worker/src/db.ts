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
