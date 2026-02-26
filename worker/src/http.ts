export class JsonBodyParseError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function parseContentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new JsonBodyParseError(400, "Invalid Content-Length header");
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new JsonBodyParseError(400, "Invalid Content-Length header");
  }

  return parsed;
}

export async function parseJsonBodyWithLimit<T>(request: Request, maxBytes: number): Promise<T> {
  const declaredLength = parseContentLength(request);
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new JsonBodyParseError(413, "Payload too large");
  }

  const raw = await request.text();
  const byteLength = new TextEncoder().encode(raw).byteLength;
  if (byteLength > maxBytes) {
    throw new JsonBodyParseError(413, "Payload too large");
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new JsonBodyParseError(400, "Invalid JSON payload");
  }
}
