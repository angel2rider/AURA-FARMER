import { SlashCommandBuilder } from 'discord.js';

export const commandData = [
  new SlashCommandBuilder()
    .setName('find')
    .setDescription('Search YouTube Music and queue a track')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('Song, artist, or album')
        .setRequired(true)
        .setMaxLength(200),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Queue every track in a YouTube or YouTube Music playlist')
    .addStringOption((option) =>
      option.setName('url').setDescription('Playlist link').setRequired(true).setMaxLength(500),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show how many tracks are waiting for the next download batch')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show Aura Farmer status')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('How to submit music to Aura')
    .toJSON(),
];

export function splitSub(sub: string): { artist: string | undefined; album: string | undefined } {
  const parts = String(sub || '')
    .split('•')
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    artist: parts[0] || undefined,
    album: parts.length > 2 ? parts[1] || undefined : undefined,
  };
}

export const COLORS = {
  gold: 0xf2c14e,
  green: 0x67d391,
  red: 0xef8b8b,
  dim: 0x8a8f98,
} as const;
