/**
 * `playbackClipsKey` must stay stable when only non-URL shot fields change.
 * SequencePlayer used to depend on `clips` identity; a shots refetch of the
 * same URLs disposed a playing engine (stuck at 0:00, #1284).
 */
import { describe, expect, it } from 'vitest';

import {
  groupPlaybackShots,
  playbackClipsKey,
  shotIdAtSequenceTime,
  toPlaybackClips,
} from './playback-clips';

const shot = (url: string | null, extra?: { status?: string }) => ({
  video: url ? { url, status: extra?.status } : null,
  image: null,
  previewThumbnailUrl: null,
  durationMs: 5000,
  audioClips: null,
});

describe('toPlaybackClips', () => {
  it('keeps completed clips and fills missing videos with timed stills', () => {
    expect(
      toPlaybackClips([shot('/a.mp4'), shot(null), shot('/c.mp4'), shot(null)])
    ).toEqual([
      { orderIndex: 0, videoUrl: '/a.mp4', posterUrl: null },
      expect.objectContaining({
        orderIndex: 1,
        imageUrl: null,
        durationSeconds: 5,
        audioUrls: [],
      }),
      { orderIndex: 2, videoUrl: '/c.mp4', posterUrl: null },
      expect.objectContaining({ orderIndex: 3, imageUrl: null }),
    ]);
  });

  it('collapses consecutive packed-segment copies into one clip (#1510)', () => {
    expect(
      toPlaybackClips([
        shot('/packed.mp4'),
        shot('/packed.mp4'),
        shot('/b.mp4'),
      ])
    ).toEqual([
      { orderIndex: 0, videoUrl: '/packed.mp4', posterUrl: null },
      { orderIndex: 1, videoUrl: '/b.mp4', posterUrl: null },
    ]);
  });
});

describe('playbackClipsKey', () => {
  it('is identical for two shot lists that only differ in non-url fields', () => {
    const a = toPlaybackClips([
      shot('/a.mp4', { status: 'completed' }),
      shot(null),
      shot('/c.mp4', { status: 'completed' }),
    ]);
    const b = toPlaybackClips([
      shot('/a.mp4', { status: 'completed' }),
      shot(null, { status: 'generating' }),
      shot('/c.mp4', { status: 'completed' }),
    ]);
    expect(playbackClipsKey(a)).toBe(playbackClipsKey(b));
    expect(a).not.toBe(b);
  });

  it('changes when a new clip lands', () => {
    const before = playbackClipsKey(
      toPlaybackClips([shot('/a.mp4'), shot(null)])
    );
    const after = playbackClipsKey(
      toPlaybackClips([shot('/a.mp4'), shot('/b.mp4')])
    );
    expect(before).not.toBe(after);
  });

  it('changes when a clip url is replaced', () => {
    expect(playbackClipsKey(toPlaybackClips([shot('/a.mp4')]))).not.toBe(
      playbackClipsKey(toPlaybackClips([shot('/a-v2.mp4')]))
    );
  });
});

it('does not collapse rendered clips across a missing shot', () => {
  expect(
    toPlaybackClips([shot('/packed.mp4'), shot(null), shot('/packed.mp4')])
  ).toHaveLength(3);
});
it('prefers the selected still and plays its recorded take only when there is no video', () => {
  const input = {
    ...shot(null),
    previewThumbnailUrl: '/preview.png',
    image: { url: '/still.png' },
    audioClips: [
      {
        id: 'take',
        url: '/take.wav',
        token: 'DIALOGUE',
        durationSeconds: 2,
      },
    ],
  };
  expect(toPlaybackClips([input])[0]).toMatchObject({
    imageUrl: '/still.png',
    fallbackImageUrl: '/preview.png',
    audioUrls: ['/take.wav'],
  });
  expect(
    toPlaybackClips([{ ...input, video: { url: '/render.mp4' } }])
  ).toEqual([
    { orderIndex: 0, videoUrl: '/render.mp4', posterUrl: '/still.png' },
  ]);
});

it('uses the preview when there is no selected still', () => {
  expect(
    toPlaybackClips([{ ...shot(null), previewThumbnailUrl: '/preview.png' }])[0]
  ).toMatchObject({
    imageUrl: '/preview.png',
    fallbackImageUrl: null,
  });
});
it('updates identity when a still, recording, duration or aspect ratio changes', () => {
  const input = { ...shot(null), image: { url: '/still.png' } };
  const key = playbackClipsKey(toPlaybackClips([input]));
  for (const changed of [
    { ...input, image: { url: '/new.png' } },
    { ...input, durationMs: 8000 },
    {
      ...input,
      audioClips: [
        { id: 'take', url: '/take.wav', token: 'DIALOGUE', durationSeconds: 2 },
      ],
    },
  ]) {
    expect(playbackClipsKey(toPlaybackClips([changed]))).not.toBe(key);
  }
  expect(playbackClipsKey(toPlaybackClips([input], '9:16'))).not.toBe(key);
});

describe('shotIdAtSequenceTime (#1771)', () => {
  const timed = (id: string, url: string | null, durationMs = 5000) => ({
    id,
    shotNumber: null,
    durationMs,
    video: url ? { url } : null,
  });
  // Clips: packed clip (s1 4s + s2 6s), still s3 (3s), clip s4 (5s).
  const shots = [
    timed('s1', '/packed.mp4', 4000),
    timed('s2', '/packed.mp4', 6000),
    timed('s3', null, 3000),
    timed('s4', '/d.mp4'),
  ];

  it('groups adjacent shots that share a clip', () => {
    expect(
      groupPlaybackShots(shots).map((group) => group.map((s) => s.id))
    ).toEqual([['s1', 's2'], ['s3'], ['s4']]);
  });

  it('splits a measured clip by the members’ own durations', () => {
    // The packed clip really runs 12s, the still 3s, the last clip 5.5s.
    const offsets = [0, 12, 15];
    expect(shotIdAtSequenceTime(shots, 0, offsets)).toBe('s1');
    expect(shotIdAtSequenceTime(shots, 4.7, offsets)).toBe('s1');
    expect(shotIdAtSequenceTime(shots, 4.9, offsets)).toBe('s2');
    expect(shotIdAtSequenceTime(shots, 12, offsets)).toBe('s3');
    expect(shotIdAtSequenceTime(shots, 15, offsets)).toBe('s4');
    expect(shotIdAtSequenceTime(shots, 99, offsets)).toBe('s4');
  });

  it('falls back to the plain estimate with no offsets', () => {
    expect(shotIdAtSequenceTime(shots, 10.5)).toBe('s3');
    expect(shotIdAtSequenceTime([], 0)).toBeUndefined();
  });
});
