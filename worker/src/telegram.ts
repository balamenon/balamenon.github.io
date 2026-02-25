import { clearSession, deleteNote, getRecentNotes, getSession, insertNote, upsertSession, updateNote } from "./db";
import { MAX_NOTE_WORDS, countWords, previewText, truncateToWords } from "./logic";
import { reindexSubstackPosts } from "./substack";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_TELEGRAM_ID: string;
}

type TelegramMessage = {
  message_id: number;
  text?: string;
  chat: { id: number };
  from?: { id: number };
};

type TelegramCallbackQuery = {
  id: string;
  data?: string;
  message?: {
    message_id: number;
    chat: { id: number };
  };
  from: { id: number };
};

type TelegramUpdate = {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function isAllowedActor(actorId: string, chatId: string, allowedId: string): boolean {
  return actorId === allowedId || chatId === allowedId;
}

function firstLine(text: string, maxLen = 50): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLen) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLen - 3)}...`;
}

async function telegramApi(env: Env, method: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Telegram API error (${method}):`, response.status, text);
  }
}

async function sendMessage(env: Env, chatId: number, text: string, replyMarkup?: Record<string, unknown>): Promise<void> {
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup,
  });
}

async function answerCallback(env: Env, callbackId: string, text: string): Promise<void> {
  await telegramApi(env, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
  });
}

async function handleOverLimitNewNote(env: Env, userId: string, chatId: number, text: string): Promise<void> {
  const truncation = truncateToWords(text, MAX_NOTE_WORDS);
  await upsertSession(env.DB, {
    userId,
    state: "awaiting_newnote_truncate_confirm",
    selectedNoteId: null,
    pendingContent: truncation.truncatedText,
  });

  await sendMessage(
    env,
    chatId,
    `Your note has ${truncation.totalWords} words. The max is ${MAX_NOTE_WORDS}. It will truncate after word ${MAX_NOTE_WORDS}.\n\nTruncated preview:\n${previewText(
      truncation.truncatedText,
      80,
    )}`,
    {
      inline_keyboard: [[{ text: "Save truncated", callback_data: "newnote_save_truncated" }], [{ text: "Cancel/Edit", callback_data: "newnote_cancel" }]],
    },
  );
}

async function handleOverLimitEdit(env: Env, userId: string, chatId: number, selectedNoteId: number, text: string): Promise<void> {
  const truncation = truncateToWords(text, MAX_NOTE_WORDS);

  await upsertSession(env.DB, {
    userId,
    state: "awaiting_edit_truncate_confirm",
    selectedNoteId,
    pendingContent: truncation.truncatedText,
  });

  await sendMessage(
    env,
    chatId,
    `Your edited note has ${truncation.totalWords} words. The max is ${MAX_NOTE_WORDS}. It will truncate after word ${MAX_NOTE_WORDS}.\n\nTruncated preview:\n${previewText(
      truncation.truncatedText,
      80,
    )}`,
    {
      inline_keyboard: [[{ text: "Save truncated edit", callback_data: "edit_save_truncated" }], [{ text: "Cancel/Edit", callback_data: "edit_cancel" }]],
    },
  );
}

async function createNoteFromText(env: Env, chatId: number, messageId: number, text: string): Promise<void> {
  const words = countWords(text);
  const noteId = await insertNote(env.DB, {
    content: text,
    wordCount: words,
    sourceMessageId: String(messageId),
    sourceChatId: String(chatId),
  });
  await sendMessage(env, chatId, `Saved note #${noteId} (${words} words).`);
}

async function updateNoteFromText(env: Env, chatId: number, noteId: number, text: string): Promise<void> {
  const words = countWords(text);
  const updated = await updateNote(env.DB, noteId, text, words);
  if (!updated) {
    await sendMessage(env, chatId, `Could not find note #${noteId}.`);
    return;
  }
  await sendMessage(env, chatId, `Updated note #${noteId} (${words} words).`);
}

async function handleMessage(env: Env, message: TelegramMessage): Promise<void> {
  const text = message.text?.trim() ?? "";
  const userId = String(message.from?.id ?? "");
  const chatId = message.chat.id;
  const chatIdString = String(chatId);

  if (!isAllowedActor(userId, chatIdString, env.ALLOWED_TELEGRAM_ID)) {
    return;
  }

  if (!text) {
    await sendMessage(env, chatId, "Please send text. Use /newnote <text>, /editnote, /deletenote, or /reindex.");
    return;
  }

  const newNoteMatch = text.match(/^\/newnote(?:@\w+)?(?:\s+([\s\S]+))?$/);
  if (newNoteMatch) {
    const body = (newNoteMatch[1] ?? "").trim();
    if (!body) {
      await sendMessage(env, chatId, "Usage: /newnote <your note text>");
      return;
    }

    const words = countWords(body);
    if (words > MAX_NOTE_WORDS) {
      await handleOverLimitNewNote(env, userId, chatId, body);
      return;
    }

    await createNoteFromText(env, chatId, message.message_id, body);
    await clearSession(env.DB, userId);
    return;
  }

  if (/^\/editnote(?:@\w+)?$/.test(text)) {
    const notes = await getRecentNotes(env.DB, 20);
    if (!notes.length) {
      await sendMessage(env, chatId, "No notes available to edit.");
      return;
    }

    const keyboard = notes.map((note) => [
      {
        text: `#${note.id} ${firstLine(note.content, 50)}`,
        callback_data: `edit_select_${note.id}`,
      },
    ]);

    await sendMessage(env, chatId, "Select a note to edit:", { inline_keyboard: keyboard });
    return;
  }

  if (/^\/deletenote(?:@\w+)?$/.test(text)) {
    const notes = await getRecentNotes(env.DB, 20);
    if (!notes.length) {
      await sendMessage(env, chatId, "No notes available to delete.");
      return;
    }

    const keyboard = notes.map((note) => [
      {
        text: `Delete #${note.id} ${firstLine(note.content, 42)}`,
        callback_data: `delete_select_${note.id}`,
      },
    ]);

    await sendMessage(env, chatId, "Select a note to delete:", { inline_keyboard: keyboard });
    return;
  }

  if (/^\/reindex(?:@\w+)?$/.test(text)) {
    await sendMessage(env, chatId, "Reindexing latest Substack posts...");
    try {
      const result = await reindexSubstackPosts(env, 10);
      await sendMessage(env, chatId, `Reindex complete. Cached ${result.count} posts from ${result.feedUrl}.`);
    } catch (error) {
      console.error("Substack reindex failed:", error);
      await sendMessage(env, chatId, "Reindex failed. Please try again in a moment.");
    }
    return;
  }

  const session = await getSession(env.DB, userId);
  if (session?.state === "awaiting_edit_text" && session.selected_note_id) {
    const words = countWords(text);
    if (words > MAX_NOTE_WORDS) {
      await handleOverLimitEdit(env, userId, chatId, session.selected_note_id, text);
      return;
    }

    await updateNoteFromText(env, chatId, session.selected_note_id, text);
    await clearSession(env.DB, userId);
    return;
  }

  await sendMessage(env, chatId, "Ignored. Use /newnote <text>, /editnote, /deletenote, or /reindex.");
}

async function handleCallback(env: Env, callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data ?? "";
  const userId = String(callback.from.id);
  const chatId = callback.message?.chat.id;

  if (!chatId) {
    await answerCallback(env, callback.id, "Missing chat context.");
    return;
  }

  if (!isAllowedActor(userId, String(chatId), env.ALLOWED_TELEGRAM_ID)) {
    await answerCallback(env, callback.id, "Not authorized.");
    return;
  }

  if (data === "newnote_save_truncated") {
    const session = await getSession(env.DB, userId);
    if (!session || session.state !== "awaiting_newnote_truncate_confirm" || !session.pending_content) {
      await answerCallback(env, callback.id, "No pending truncated note found.");
      return;
    }

    const words = countWords(session.pending_content);
    const noteId = await insertNote(env.DB, {
      content: session.pending_content,
      wordCount: words,
      sourceChatId: String(chatId),
    });

    await clearSession(env.DB, userId);
    await answerCallback(env, callback.id, "Saved truncated note.");
    await sendMessage(env, chatId, `Saved truncated note #${noteId} (${words} words).`);
    return;
  }

  if (data === "newnote_cancel") {
    await clearSession(env.DB, userId);
    await answerCallback(env, callback.id, "Cancelled. Send /newnote with revised content.");
    return;
  }

  if (data.startsWith("edit_select_")) {
    const noteId = Number(data.replace("edit_select_", ""));
    if (!Number.isInteger(noteId) || noteId <= 0) {
      await answerCallback(env, callback.id, "Invalid note selection.");
      return;
    }

    await upsertSession(env.DB, {
      userId,
      state: "awaiting_edit_text",
      selectedNoteId: noteId,
      pendingContent: null,
    });

    await answerCallback(env, callback.id, `Selected note #${noteId}.`);
    await sendMessage(env, chatId, `Send replacement text for note #${noteId}.`);
    return;
  }

  if (data === "edit_save_truncated") {
    const session = await getSession(env.DB, userId);
    if (!session || session.state !== "awaiting_edit_truncate_confirm" || !session.selected_note_id || !session.pending_content) {
      await answerCallback(env, callback.id, "No pending truncated edit found.");
      return;
    }

    const words = countWords(session.pending_content);
    const updated = await updateNote(env.DB, session.selected_note_id, session.pending_content, words);
    if (!updated) {
      await answerCallback(env, callback.id, "Note no longer exists.");
      await clearSession(env.DB, userId);
      return;
    }

    await clearSession(env.DB, userId);
    await answerCallback(env, callback.id, "Saved truncated edit.");
    await sendMessage(env, chatId, `Updated note #${session.selected_note_id} with truncated content (${words} words).`);
    return;
  }

  if (data === "edit_cancel") {
    const session = await getSession(env.DB, userId);
    if (session?.selected_note_id) {
      await upsertSession(env.DB, {
        userId,
        state: "awaiting_edit_text",
        selectedNoteId: session.selected_note_id,
        pendingContent: null,
      });
    }
    await answerCallback(env, callback.id, "Cancelled truncation. Send revised replacement text.");
    return;
  }

  if (data.startsWith("delete_select_")) {
    const noteId = Number(data.replace("delete_select_", ""));
    if (!Number.isInteger(noteId) || noteId <= 0) {
      await answerCallback(env, callback.id, "Invalid note selection.");
      return;
    }

    const deleted = await deleteNote(env.DB, noteId);
    if (!deleted) {
      await answerCallback(env, callback.id, "Note no longer exists.");
      await sendMessage(env, chatId, `Could not delete note #${noteId}; it may have already been removed.`);
      return;
    }

    await answerCallback(env, callback.id, `Deleted note #${noteId}.`);
    await sendMessage(env, chatId, `Deleted note #${noteId}.`);
    return;
  }

  await answerCallback(env, callback.id, "Unknown action.");
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const providedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!env.TELEGRAM_WEBHOOK_SECRET || providedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON payload" }, 400);
  }

  if (update.message) {
    await handleMessage(env, update.message);
  } else if (update.callback_query) {
    await handleCallback(env, update.callback_query);
  }

  return jsonResponse({ ok: true });
}
