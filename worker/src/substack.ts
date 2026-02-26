import { getSubstackPosts, upsertSubstackPosts, type StoredSubstackPost } from "./db";

export type SubstackEnv = {
  DB: D1Database;
  SUBSTACK_FEED_URL?: string;
};

export type SubstackPost = {
  title: string;
  link: string;
  description: string;
  pub_date: string;
  published_at: number;
};

function normalizeSafeExternalUrl(raw: string): string | null {
  const candidate = raw.trim();
  if (!candidate) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") {
    return null;
  }

  return parsed.toString();
}

function decodeXmlEntities(text: string): string {
  const withoutCdata = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const namedDecoded = withoutCdata
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

  return namedDecoded
    .replace(/&#(\d+);/g, (_, codePoint) => {
      const value = Number.parseInt(codePoint, 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, codePointHex) => {
      const value = Number.parseInt(codePointHex, 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    });
}

function stripHtml(text: string): string {
  return decodeXmlEntities(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTag(block: string, tagName: string): string {
  const safeTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`<${safeTag}[^>]*>([\\s\\S]*?)<\/${safeTag}>`, "i"));
  return match?.[1]?.trim() ?? "";
}

function parseRssItems(xml: string, limit?: number): SubstackPost[] {
  const itemBlocks = Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)).map((match) => match[0]);
  const posts: SubstackPost[] = [];
  const safeLimit = typeof limit === "number" ? Math.max(1, Math.min(limit, 5000)) : null;

  for (const block of itemBlocks) {
    const title = stripHtml(extractTag(block, "title"));
    const link = normalizeSafeExternalUrl(decodeXmlEntities(extractTag(block, "link")));
    const rawDescription = extractTag(block, "description") || extractTag(block, "content:encoded");
    const description = stripHtml(rawDescription);
    const pubDate = decodeXmlEntities(extractTag(block, "pubDate"));

    if (!title || !link) {
      continue;
    }

    posts.push({
      title,
      link,
      description,
      pub_date: pubDate,
      published_at: Date.parse(pubDate) || 0,
    });

    if (safeLimit !== null && posts.length >= safeLimit) {
      break;
    }
  }

  return posts;
}

export async function reindexSubstackPosts(env: SubstackEnv, limit?: number): Promise<{ feedUrl: string; count: number; posts: SubstackPost[] }> {
  const feedUrl = env.SUBSTACK_FEED_URL?.trim() || "https://ondeviceguy.substack.com/feed";

  const feedResponse = await fetch(feedUrl, {
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    },
  });

  if (!feedResponse.ok) {
    throw new Error(`FEED_FETCH_FAILED_${feedResponse.status}`);
  }

  const feedText = await feedResponse.text();
  const posts = parseRssItems(feedText, limit);
  await upsertSubstackPosts(env.DB, posts);

  return {
    feedUrl,
    count: posts.length,
    posts,
  };
}

export async function listCachedSubstackPosts(env: SubstackEnv, limit = 10): Promise<StoredSubstackPost[]> {
  return getSubstackPosts(env.DB, limit);
}
