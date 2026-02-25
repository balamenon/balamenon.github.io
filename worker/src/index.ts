import { getAllNotes, updateNote } from "./db";
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), request);
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return withCors(json({ ok: true }), request);
    }

    if (request.method === "GET" && url.pathname === "/api/notes") {
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

    return withCors(json({ ok: false, error: "Not found" }, { status: 404 }), request);
  },
};
