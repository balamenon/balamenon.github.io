import { getAllNotes, getNoteThoughtTarget, updateNote } from "./db";
import { MAX_NOTE_WORDS, countWords, paginateNotes } from "./logic";
import { handleTelegramWebhook, type Env as TelegramEnv } from "./telegram";

type Env = TelegramEnv & {
  INTERNAL_API_TOKEN?: string;
};

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Telegram-Bot-Api-Secret-Token",
  };
}

function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(request);
  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handleNotesApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(url.searchParams.get("page_size") ?? "10", 10);

  const allNotes = await getAllNotes(env.DB);
  const payload = paginateNotes(allNotes, Number.isNaN(page) ? 1 : page, Number.isNaN(pageSize) ? 10 : pageSize);

  return json(payload);
}

async function handleInternalEditApi(request: Request, env: Env, noteId: number): Promise<Response> {
  const authHeader = request.headers.get("authorization") ?? "";
  const expected = env.INTERNAL_API_TOKEN?.trim();

  if (!expected || authHeader !== `Bearer ${expected}`) {
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { content?: string };
  try {
    body = (await request.json()) as { content?: string };
  } catch {
    return json({ ok: false, error: "Invalid JSON payload" }, { status: 400 });
  }

  const content = body.content?.trim();
  if (!content) {
    return json({ ok: false, error: "content is required" }, { status: 400 });
  }

  const words = countWords(content);
  if (words > MAX_NOTE_WORDS) {
    return json(
      {
        ok: false,
        error: `content exceeds ${MAX_NOTE_WORDS} words`,
      },
      { status: 400 },
    );
  }

  const updated = await updateNote(env.DB, noteId, content, words);
  if (!updated) {
    return json({ ok: false, error: "Note not found" }, { status: 404 });
  }

  return json({ ok: true, note_id: noteId, word_count: words });
}

async function sendTelegramThought(env: Env, input: { noteId: number; sender: string; message: string }): Promise<void> {
  const target = await getNoteThoughtTarget(env.DB, input.noteId);
  if (!target) {
    throw new Error("NOTE_NOT_FOUND");
  }

  const noteExcerpt = target.content.replace(/\s+/g, " ").trim().slice(0, 160);
  const noteTimestamp = target.created_at;
  const destinationChat = target.source_chat_id?.trim() || env.ALLOWED_TELEGRAM_ID;
  const messageId = target.source_message_id ? Number.parseInt(target.source_message_id, 10) : NaN;
  const normalizedSender = input.sender.trim();
  let senderLine = normalizedSender;

  if (normalizedSender.startsWith("@")) {
    const xUsername = normalizedSender.slice(1).match(/^[A-Za-z0-9_]{1,15}$/)?.[0];
    if (xUsername) {
      senderLine = `${normalizedSender} (https://x.com/${xUsername})`;
    }
  }

  const text =
    `💬 New thought on note #${target.id}\n` +
    `From: ${senderLine}\n` +
    `Note date: ${noteTimestamp}\n` +
    `Excerpt: ${noteExcerpt}${target.content.length > 160 ? "..." : ""}\n\n` +
    `${input.message}`;

  const payload: Record<string, unknown> = {
    chat_id: destinationChat,
    text,
  };

  if (Number.isInteger(messageId) && messageId > 0 && target.source_chat_id?.trim()) {
    payload.reply_parameters = {
      message_id: messageId,
    };
  }

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Thought relay failed:", response.status, detail);
    throw new Error("TELEGRAM_RELAY_FAILED");
  }
}

async function handleThoughtsApi(request: Request, env: Env, noteId: number): Promise<Response> {
  let body: { sender?: string; message?: string };
  try {
    body = (await request.json()) as { sender?: string; message?: string };
  } catch {
    return json({ ok: false, error: "Invalid JSON payload" }, { status: 400 });
  }

  const sender = body.sender?.trim() ?? "";
  const message = body.message?.trim() ?? "";

  if (!sender || sender.length > 80) {
    return json({ ok: false, error: "sender is required and must be <= 80 characters" }, { status: 400 });
  }

  if (!message || message.length > 2000) {
    return json({ ok: false, error: "message is required and must be <= 2000 characters" }, { status: 400 });
  }

  try {
    await sendTelegramThought(env, { noteId, sender, message });
  } catch (error) {
    if (error instanceof Error && error.message === "NOTE_NOT_FOUND") {
      return json({ ok: false, error: "Note not found" }, { status: 404 });
    }
    return json({ ok: false, error: "Could not send thought right now" }, { status: 502 });
  }

  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), request);
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return withCors(json({ ok: true }), request);
    }

    if (request.method === "GET" && (url.pathname === "/api/notes" || url.pathname === "/notes")) {
      const response = await handleNotesApi(request, env);
      return withCors(response, request);
    }

    if (request.method === "POST" && url.pathname === "/api/telegram/webhook") {
      const response = await handleTelegramWebhook(request, env);
      return withCors(response, request);
    }

    const editMatch = url.pathname.match(/^\/api\/notes\/(\d+)\/edit$/);
    if (request.method === "POST" && editMatch) {
      const noteId = Number.parseInt(editMatch[1], 10);
      const response = await handleInternalEditApi(request, env, noteId);
      return withCors(response, request);
    }

    const thoughtsMatch = url.pathname.match(/^\/api\/notes\/(\d+)\/thoughts$/);
    if (request.method === "POST" && thoughtsMatch) {
      const noteId = Number.parseInt(thoughtsMatch[1], 10);
      const response = await handleThoughtsApi(request, env, noteId);
      return withCors(response, request);
    }

    return withCors(json({ ok: false, error: "Not found" }, { status: 404 }), request);
  },
};
