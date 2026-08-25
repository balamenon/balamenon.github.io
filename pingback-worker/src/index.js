const MAX_BODY_BYTES = 12 * 1024;
const MAX_NAME_LENGTH = 80;
const MAX_REPLY_TO_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_TURNSTILE_LENGTH = 2048;
const TURNSTILE_ACTION = "pingback";
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function configuredSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const allowed = configuredSet(env.ALLOWED_ORIGINS);
  if (!origin || !allowed.has(origin)) {
    return null;
  }

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function cleanMultiline(value) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
}

function cleanSingleLine(value) {
  return cleanMultiline(value).replace(/[\n\t]+/g, " ").replace(/\s{2,}/g, " ");
}

function stringField(input, name) {
  const value = input[name];
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

export function parsePingbackPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Invalid request payload");
  }

  const website = cleanSingleLine(stringField(input, "website"));
  if (website) {
    throw new TypeError("Invalid form submission");
  }

  const name = cleanSingleLine(stringField(input, "name"));
  const replyTo = cleanSingleLine(stringField(input, "replyTo"));
  const message = cleanMultiline(stringField(input, "message"));
  const turnstileToken = stringField(input, "turnstileToken").trim();

  if (!message) {
    throw new TypeError("Message is required");
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new TypeError(`Name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }
  if (replyTo.length > MAX_REPLY_TO_LENGTH) {
    throw new TypeError(`Reply address must be ${MAX_REPLY_TO_LENGTH} characters or fewer`);
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new TypeError(`Message must be ${MAX_MESSAGE_LENGTH} characters or fewer`);
  }
  if (!turnstileToken || turnstileToken.length > MAX_TURNSTILE_LENGTH) {
    throw new TypeError("Verification is required");
  }

  return { name, replyTo, message, turnstileToken };
}

async function parseJsonWithLimit(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    const error = new TypeError("Content-Type must be application/json");
    error.status = 415;
    throw error;
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_BODY_BYTES) {
    const error = new TypeError("Request is too large");
    error.status = 413;
    throw error;
  }

  if (!request.body) {
    throw new TypeError("Request body is required");
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        const error = new TypeError("Request is too large");
        error.status = 413;
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Request body must be valid UTF-8");
  }

  try {
    return JSON.parse(decoded);
  } catch {
    throw new TypeError("Request body must be valid JSON");
  }
}

async function verifyTurnstile(request, env, token) {
  const secret = String(env.TURNSTILE_SECRET_KEY || "").trim();
  const allowedHostnames = configuredSet(env.TURNSTILE_HOSTNAMES);
  if (!secret || allowedHostnames.size === 0) {
    return { ok: false, configurationError: true };
  }

  const form = new URLSearchParams({
    secret,
    response: token,
    idempotency_key: crypto.randomUUID(),
  });
  const remoteIp = request.headers.get("cf-connecting-ip");
  if (remoteIp) {
    form.set("remoteip", remoteIp);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false };
    }

    const result = await response.json();
    return {
      ok:
        result.success === true &&
        result.action === TURNSTILE_ACTION &&
        typeof result.hostname === "string" &&
        allowedHostnames.has(result.hostname),
    };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function handlePingback(request, env) {
  const cors = corsHeaders(request, env);
  if (!cors) {
    return json({ ok: false, error: "Origin not allowed" }, 403);
  }

  if (!env.PINGBACKS || !env.PINGBACK_RATE_LIMITER) {
    return json({ ok: false, error: "Message service is not configured" }, 503, cors);
  }

  const rateKey = request.headers.get("cf-connecting-ip") || "missing-ip";
  const rateResult = await env.PINGBACK_RATE_LIMITER.limit({ key: `pingback:${rateKey}` });
  if (!rateResult.success) {
    return json({ ok: false, error: "Too many messages. Please wait a minute and try again." }, 429, {
      ...cors,
      "retry-after": "60",
    });
  }

  let parsed;
  try {
    parsed = parsePingbackPayload(await parseJsonWithLimit(request));
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 400;
    const message = error instanceof TypeError ? error.message : "Invalid request";
    return json({ ok: false, error: message }, status, cors);
  }

  const turnstile = await verifyTurnstile(request, env, parsed.turnstileToken);
  if (turnstile.configurationError) {
    return json({ ok: false, error: "Verification service is not configured" }, 503, cors);
  }
  if (!turnstile.ok) {
    return json({ ok: false, error: "Verification failed. Please try again." }, 400, cors);
  }

  const pingbackId = crypto.randomUUID();
  await env.PINGBACKS.send({
    version: 1,
    pingbackId,
    receivedAt: new Date().toISOString(),
    name: parsed.name,
    replyTo: parsed.replyTo,
    message: parsed.message,
  });

  return json({ ok: true, queued: true, id: pingbackId }, 202, cors);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname === "/api/pingbacks") {
      const cors = corsHeaders(request, env);
      return cors ? new Response(null, { status: 204, headers: cors }) : json({ ok: false }, 403);
    }

    if (request.method === "POST" && url.pathname === "/api/pingbacks") {
      return handlePingback(request, env);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};
