import { consumeThoughtRateLimit, getAllNotes, getNoteThoughtTarget, updateNote } from "./db";
import { MAX_NOTE_WORDS, countWords, paginateNotes } from "./logic";
import { listCachedSubstackPosts, toJsonl } from "./substack";
import { handleTelegramWebhook, type Env as TelegramEnv } from "./telegram";

type Env = TelegramEnv & {
  INTERNAL_API_TOKEN?: string;
  SUBSTACK_FEED_URL?: string;
  ALLOWED_ORIGINS?: string;
  TURNSTILE_SECRET_KEY?: string;
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

function parseAllowedOrigins(env: Env): Set<string> {
  const configured = env.ALLOWED_ORIGINS?.trim();
  if (!configured) {
    return new Set(["https://balamenon.com", "https://www.balamenon.com", "https://balamenon.github.io"]);
  }

  return new Set(
    configured
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function resolveCorsOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return null;
  }

  const allowed = parseAllowedOrigins(env);
  return allowed.has(origin) ? origin : null;
}

function withCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  const allowedOrigin = resolveCorsOrigin(request, env);

  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Telegram-Bot-Api-Secret-Token");
    headers.set("Vary", "Origin");
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
    `Received: ${new Date().toISOString()}\n\n` +
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

async function verifyTurnstile(request: Request, env: Env, token: string): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) {
    return true;
  }

  if (!token) {
    return false;
  }

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);

  const remoteIp = request.headers.get("CF-Connecting-IP");
  if (remoteIp) {
    form.set("remoteip", remoteIp);
  }

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });

    if (!response.ok) {
      return false;
    }

    const payload = (await response.json()) as { success?: boolean };
    return payload.success === true;
  } catch {
    return false;
  }
}

function enforceAllowedOrigin(request: Request, env: Env): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return null;
  }

  if (!resolveCorsOrigin(request, env)) {
    return json({ ok: false, error: "Origin not allowed" }, { status: 403 });
  }

  return null;
}

async function handleThoughtsApi(request: Request, env: Env, noteId: number): Promise<Response> {
  const blockedOrigin = enforceAllowedOrigin(request, env);
  if (blockedOrigin) {
    return blockedOrigin;
  }

  const ip = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
  const rateResult = await consumeThoughtRateLimit(env.DB, `thought:${ip}`, 8, 60);
  if (!rateResult.allowed) {
    return json(
      {
        ok: false,
        error: "Too many requests, please wait and try again.",
        retry_after_seconds: rateResult.retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateResult.retryAfterSeconds),
        },
      },
    );
  }

  let body: { sender?: string; message?: string; turnstile_token?: string };
  try {
    body = (await request.json()) as { sender?: string; message?: string; turnstile_token?: string };
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

  const turnstileOk = await verifyTurnstile(request, env, body.turnstile_token?.trim() ?? "");
  if (!turnstileOk) {
    return json({ ok: false, error: "Verification failed" }, { status: 400 });
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

async function handleSubstackPostsApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "10", 10);
  const limit = Number.isNaN(rawLimit) ? 10 : Math.max(1, Math.min(rawLimit, 20));
  const posts = await listCachedSubstackPosts(env, limit);
  return json({
    ok: true,
    source: "d1-cache",
    posts,
  });
}

async function handleSubstackJsonlApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "10", 10);
  const limit = Number.isNaN(rawLimit) ? 10 : Math.max(1, Math.min(rawLimit, 20));
  const posts = await listCachedSubstackPosts(env, limit);
  const body = toJsonl(posts);

  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin");
      if (origin && !resolveCorsOrigin(request, env)) {
        return json({ ok: false, error: "Origin not allowed" }, { status: 403 });
      }
      return withCors(new Response(null, { status: 204 }), request, env);
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return withCors(json({ ok: true }), request, env);
    }

    if (request.method === "GET" && (url.pathname === "/api/notes" || url.pathname === "/notes")) {
      const response = await handleNotesApi(request, env);
      return withCors(response, request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/telegram/webhook") {
      const response = await handleTelegramWebhook(request, env);
      return withCors(response, request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/substack/posts") {
      const response = await handleSubstackPostsApi(request, env);
      return withCors(response, request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/substack/posts.jsonl") {
      const response = await handleSubstackJsonlApi(request, env);
      return withCors(response, request, env);
    }

    const editMatch = url.pathname.match(/^\/api\/notes\/(\d+)\/edit$/);
    if (request.method === "POST" && editMatch) {
      const noteId = Number.parseInt(editMatch[1], 10);
      const response = await handleInternalEditApi(request, env, noteId);
      return withCors(response, request, env);
    }

    const thoughtsMatch = url.pathname.match(/^\/api\/notes\/(\d+)\/thoughts$/);
    if (request.method === "POST" && thoughtsMatch) {
      const noteId = Number.parseInt(thoughtsMatch[1], 10);
      const response = await handleThoughtsApi(request, env, noteId);
      return withCors(response, request, env);
    }

    return withCors(json({ ok: false, error: "Not found" }, { status: 404 }), request, env);
  },
};
