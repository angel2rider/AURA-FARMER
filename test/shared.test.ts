import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalVideoUrl,
  extractPlaylistUrls,
  extractVideoIds,
  isPlaylistUrl,
  playlistIdFromUrl,
  videoIdFromUrl,
} from '../src/shared/urls';
import { channelList, normalizeSettings } from '../src/shared/settings';

test('extracts video ids from every YouTube URL shape', () => {
  const text = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/9bZkp7q19f0?t=30',
    '<https://music.youtube.com/watch?v=kJQP7kiw5Fk>',
    'https://youtube.com/shorts/3JZ_D3ELwOQ',
    'https://www.youtube.com/live/L_jWHffIx5E',
  ].join('\n');
  assert.deepEqual(extractVideoIds(text).sort(), [
    '3JZ_D3ELwOQ',
    '9bZkp7q19f0',
    'L_jWHffIx5E',
    'dQw4w9WgXcQ',
    'kJQP7kiw5Fk',
  ]);
});

test('dedupes repeated links and reads a single URL', () => {
  const url = 'https://youtu.be/dQw4w9WgXcQ';
  assert.equal(videoIdFromUrl(url), 'dQw4w9WgXcQ');
  assert.deepEqual(extractVideoIds(`${url}\n${url}`), ['dQw4w9WgXcQ']);
});

test('rejects non-YouTube and malformed ids', () => {
  assert.equal(videoIdFromUrl('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(videoIdFromUrl('https://youtu.be/short'), null);
  assert.deepEqual(extractVideoIds('nothing here'), []);
});

test('recognises playlists', () => {
  const url = 'https://music.youtube.com/playlist?list=OLAK5uy_mabc123';
  assert.equal(isPlaylistUrl(url), true);
  assert.equal(playlistIdFromUrl(url), 'OLAK5uy_mabc123');
  assert.deepEqual(extractPlaylistUrls(`listen: <${url}>`), [url]);
  assert.equal(isPlaylistUrl('https://youtu.be/dQw4w9WgXcQ'), false);
});

test('canonical URL is stable', () => {
  assert.equal(canonicalVideoUrl('dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('settings normalize clamp unsafe values', () => {
  const settings = normalizeSettings({
    threshold: 500,
    dispatchSize: 200,
    cooldownSeconds: -10,
    dailyLimit: '12',
    channelIds: ' 123456789, 987654321 ',
    enabled: 'false',
  });
  assert.equal(settings.threshold, 300);
  assert.equal(settings.dispatchSize, 25);
  assert.equal(settings.cooldownSeconds, 0);
  assert.equal(settings.dailyLimit, 12);
  assert.equal(settings.enabled, false);
  assert.deepEqual(channelList(settings.channelIds), ['123456789', '987654321']);
});

test('channel list ignores junk', () => {
  assert.deepEqual(channelList('12345,not-an-id, 999999999999'), ['12345', '999999999999']);
});
