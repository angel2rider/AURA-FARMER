const VIDEO_RE =
  /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/gi;

const PLAYLIST_RE =
  /https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\/playlist\?(?:[^#\s]*&)?list=([A-Za-z0-9_-]{10,})/i;

const PLAYLIST_RE_G =
  /https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\/playlist\?(?:[^#\s]*&)?list=([A-Za-z0-9_-]{10,})/gi;

export function videoIdFromUrl(value: string): string | null {
  const url = value.trim();
  const match = new RegExp(VIDEO_RE.source, 'i').exec(url);
  return match?.[1] ?? null;
}

export function extractVideoIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(VIDEO_RE)) {
    if (match[1]) ids.add(match[1]);
  }
  return [...ids];
}

export function canonicalVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function playlistIdFromUrl(value: string): string | null {
  return PLAYLIST_RE.exec(value.trim())?.[1] ?? null;
}

export function isPlaylistUrl(value: string): boolean {
  return playlistIdFromUrl(value) !== null;
}

export function extractPlaylistUrls(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(PLAYLIST_RE_G)) {
    if (match[0]) out.add(match[0]);
  }
  return [...out];
}

export function looksLikeYouTubeUrl(value: string): boolean {
  return /youtu(?:\.be|be\.com)/i.test(value);
}
