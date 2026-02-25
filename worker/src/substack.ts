import { getSubstackPosts, replaceSubstackPosts, type StoredSubstackPost } from "./db";

export type SubstackEnv = {
  DB: D1Database;
  SUBSTACK_FEED_URL?: string;
};

export type SubstackPost = {
  title: string;
  link: string;
  description: string;
  pub_date: string;
};

function decodeXmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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

function parseRssItems(xml: string, limit: number): SubstackPost[] {
  const itemBlocks = Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)).map((match) => match[0]);
  const posts: SubstackPost[] = [];

  for (const block of itemBlocks) {
    const title = stripHtml(extractTag(block, "title"));
    const link = decodeXmlEntities(extractTag(block, "link"));
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
    });

    if (posts.length >= limit) {
      break;
    }
  }

  return posts;
}

export async function reindexSubstackPosts(env: SubstackEnv, limit = 10): Promise<{ feedUrl: string; count: number }> {
  const safeLimit = Math.max(1, Math.min(limit, 20));
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
  const posts = parseRssItems(feedText, safeLimit);
  await replaceSubstackPosts(env.DB, posts);

  return {
    feedUrl,
    count: posts.length,
  };
}

export async function listCachedSubstackPosts(env: SubstackEnv, limit = 10): Promise<StoredSubstackPost[]> {
  return getSubstackPosts(env.DB, limit);
}

export function toJsonl(posts: StoredSubstackPost[]): string {
  return posts
    .map((post) =>
      JSON.stringify({
        title: post.title,
        link: post.link,
        description: post.description,
        pub_date: post.pub_date,
      }),
    )
    .join("\n");
}
