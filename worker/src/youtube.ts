export interface OEmbed {
  title: string;
  author_name: string;
  thumbnail_url?: string;
}

const cache = new Map<string, { value: OEmbed; at: number }>();
const TTL = 6 * 60 * 60 * 1000;

export async function fetchOEmbed(videoId: string): Promise<OEmbed | null> {
  const hit = cache.get(videoId);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as OEmbed;
    if (!data || !data.title) return null;
    const value = { title: String(data.title).slice(0, 200), author_name: String(data.author_name || 'YouTube').slice(0, 200), thumbnail_url: data.thumbnail_url };
    cache.set(videoId, { value, at: Date.now() });
    if (cache.size > 500) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
      for (const [key] of oldest) cache.delete(key);
    }
    return value;
  } catch {
    return null;
  }
}

export async function hydrateItems<T extends { videoId: string; title?: string; artist?: string }>(items: T[]): Promise<T[]> {
  const missing = items.filter((i) => !i.title);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, missing.length) }, async () => {
    while (cursor < missing.length) {
      const item = missing[cursor++];
      if (!item) continue;
      const meta = await fetchOEmbed(item.videoId);
      if (meta) {
        item.title = meta.title;
        item.artist = item.artist || meta.author_name;
      }
    }
  });
  await Promise.all(workers);
  return items;
}
