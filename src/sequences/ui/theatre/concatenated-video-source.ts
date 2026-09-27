/**
 * A "logical" Mediabunny video source that stitches N clip MP4s into a single
 * canvas/packet stream with monotonically-increasing global timestamps.
 *
 * Used by:
 * - The live `<SequencePlayer>` — `canvases(globalTime)` yields `WrappedCanvas`
 *   frames whose timestamp is offset by each clip's cumulative start, so the
 *   player's `AudioContext`-clock-driven render loop can compare against a
 *   single timeline.
 * - The export pipeline — `packets(globalTime)` yields `EncodedPacket`s whose
 *   timestamps are offset the same way, ready to feed into an
 *   `EncodedVideoPacketSource` for transmux into a single MP4.
 *
 * Clip durations and display dimensions are precomputed in `prepare()` so that
 * `seek(globalTime)` is O(log N) and the player can build a progress bar before
 * playback begins.
 */

import {
  ALL_FORMATS,
  CanvasSink,
  EncodedPacket,
  EncodedPacketSink,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  UrlSource,
  type WrappedCanvas,
} from 'mediabunny';
import { createRangedSource } from './ranged-source';
import {
  computeTargetResolution,
  describeResolutions,
  detectMixedAspectRatios,
  detectMixedResolutions,
  type SceneDimensions,
} from './resolution';
import {
  canTransmuxScenes,
  decoderConfigDescriptionHex,
  type SceneCodecProbe,
} from './transmux';

import { getLogger } from '@/platform/logger';
import type { PlaybackClip } from './playback-clip';

export type { PlaybackClip };

const logger = getLogger(['openstory', 'sequence-player', 'concat-source']);

type CanvasFit = 'fill' | 'contain' | 'cover';

/** How much of the next clip `prefetch` reads ahead of the cut. */
const PREFETCH_SECONDS = 1;

export type ClipSlice = {
  /** Index into the (sorted) clips array. */
  clipIndex: number;
  /** Time within that clip, in seconds. */
  localTime: number;
};

export type ConcatenatedVideoMeta = {
  /** Total stitched duration in seconds. */
  totalDurationSeconds: number;
  /** Per-clip duration (seconds), in order. */
  clipDurationsSeconds: number[];
  /** Cumulative clip start offsets (seconds), in order. */
  clipOffsetsSeconds: number[];
  /**
   * Common target dimensions every clip is normalized to. This is the
   * bounding box (max width × max height) of all clips, so mismatched clips
   * are letterboxed into it without cropping. For a uniform sequence this is
   * just the shared per-clip size.
   */
  displayWidth: number;
  displayHeight: number;
  /** Per-clip native dimensions, in order. */
  clipDimensions: SceneDimensions[];
  /**
   * True when the clips resolve to more than one distinct native resolution —
   * the models disagree on pixel dimensions, so the output is normalized and
   * the user should be warned (#791).
   */
  hasMixedResolutions: boolean;
  /**
   * True when the clips' aspect ratios also differ (beyond rounding noise) —
   * normalization letterboxes/pillarboxes. When resolutions are mixed but
   * ratios match, smaller clips are simply upscaled to fill the target.
   */
  hasMixedAspectRatios: boolean;
  /**
   * Human-readable list of the distinct resolutions present, e.g.
   * `"1920×1080, 1280×1280"`. Empty string when uniform.
   */
  resolutionsLabel: string;
  /**
   * True when every clip is AVC with a byte-identical decoder config, so the
   * export can transmux without re-encoding. When false, transmux is unsafe
   * and the export falls back to decode→normalize→re-encode (`packets()`
   * refuses to run).
   */
  canTransmux: boolean;
};

export type ClipAudioTrack = {
  /** Index into the (sorted) clips array. */
  clipIndex: number;
  /** Cumulative clip start offset (seconds) — where this audio is anchored on the global timeline. */
  clipOffsetSeconds: number;
  track: InputAudioTrack;
  /** External still dialogue may be PCM, decoded by Mediabunny itself. */
  isStill: boolean;
};

type StillFrame = HTMLImageElement | ImageBitmap;

type OpenedClip = {
  inputs: Input[];
  videoTrack: InputVideoTrack | null;
  image: StillFrame | null;
  audioTracks: { track: InputAudioTrack; offset: number }[];
  duration: number;
  dimensions: SceneDimensions;
  codecProbe: SceneCodecProbe | null;
};

function closeStill(image: StillFrame | null): void {
  if (image && 'close' in image) image.close();
}

export class ConcatenatedVideoSource {
  private readonly clips: PlaybackClip[];
  private inputs: Input[] = [];
  private videoTracks: Array<InputVideoTrack | null> = [];
  private images: Array<StillFrame | null> = [];
  private readonly abort = new AbortController();
  private audioTracks: OpenedClip['audioTracks'][] = [];
  private meta: ConcatenatedVideoMeta | null = null;
  private disposed = false;

  constructor(clips: PlaybackClip[]) {
    if (clips.length === 0) {
      throw new Error('ConcatenatedVideoSource: at least one clip is required');
    }
    this.clips = [...clips].sort((a, b) => a.orderIndex - b.orderIndex);
  }

  /**
   * Open every clip's `Input`, probe duration + display dimensions, and build
   * the cumulative offset table. Must be called once before any iterator.
   */
  async prepare(
    onProgress?: (loadedClips: number, totalClips: number) => void
  ): Promise<ConcatenatedVideoMeta> {
    if (this.meta) return this.meta;

    // Open every clip concurrently — on a slow connection the per-clip
    // header fetch is latency-bound, so N sequential opens meant N round-trips
    // before the first frame could show (#1253). Order is preserved by index.
    let loaded = 0;
    const settled = await Promise.allSettled(
      this.clips.map(async (clip, i) => {
        const result = await this.openClip(clip, i);
        onProgress?.(++loaded, this.clips.length);
        return result;
      })
    );
    const opened: OpenedClip[] = [];
    let failure: unknown = null;
    for (const s of settled) {
      if (s.status === 'fulfilled') opened.push(s.value);
      else failure ??= s.reason;
    }
    // Nothing is assigned to `this.inputs` until below, so a dispose() that
    // ran mid-open couldn't reach these — release them here.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- flips during the await
    if (failure !== null || this.disposed) {
      for (const o of opened) {
        for (const input of o.inputs) input.dispose();
        closeStill(o.image);
      }
      throw failure ?? new Error('ConcatenatedVideoSource disposed');
    }
    const inputs = opened.flatMap((o) => o.inputs);
    const videoTracks = opened.map((o) => o.videoTrack);
    const audioTracks = opened.map((o) => o.audioTracks);
    const clipDurationsSeconds = opened.map((o) => o.duration);
    const clipDimensions = opened.map((o) => o.dimensions);
    // Codec + decoder-config probes, fed to `canTransmuxScenes()` to decide
    // the fast transmux path vs. decode→re-encode.
    const codecProbes = opened.flatMap((o) =>
      o.codecProbe ? [o.codecProbe] : []
    );

    const clipOffsetsSeconds: number[] = [];
    let acc = 0;
    for (const d of clipDurationsSeconds) {
      clipOffsetsSeconds.push(acc);
      acc += d;
    }

    // Preview dimensions must not inflate video resolution or create model warnings.
    const videoDimensions = opened
      .filter((o) => o.videoTrack)
      .map((o) => o.dimensions);
    const target = computeTargetResolution(
      videoDimensions.length ? videoDimensions : clipDimensions
    );
    const hasMixedResolutions = detectMixedResolutions(videoDimensions);

    this.inputs = inputs;
    this.images = opened.map((o) => o.image);
    this.videoTracks = videoTracks;
    this.audioTracks = audioTracks;
    this.meta = {
      totalDurationSeconds: acc,
      clipDurationsSeconds,
      clipOffsetsSeconds,
      displayWidth: target.width,
      displayHeight: target.height,
      clipDimensions,
      hasMixedResolutions,
      hasMixedAspectRatios: detectMixedAspectRatios(videoDimensions),
      resolutionsLabel: hasMixedResolutions
        ? describeResolutions(videoDimensions)
        : '',
      canTransmux:
        codecProbes.length === opened.length && canTransmuxScenes(codecProbes),
    };
    return this.meta;
  }

  private async openClip(clip: PlaybackClip, i: number): Promise<OpenedClip> {
    if (!('videoUrl' in clip)) return this.openStill(clip);
    const input = new Input({
      formats: ALL_FORMATS,
      source: createRangedSource(clip.videoUrl),
    });
    try {
      return await this.probeClip(input, i);
    } catch (err) {
      input.dispose();
      throw err;
    }
  }

  private async openStill(
    clip: Extract<PlaybackClip, { imageUrl: string | null }>
  ): Promise<OpenedClip> {
    const inputs: Input[] = [];
    let image: StillFrame | null = null;
    try {
      for (const url of [clip.imageUrl, clip.fallbackImageUrl]) {
        if (!url) continue;
        try {
          image = await this.decodeStill(url);
          break;
        } catch (error) {
          if (this.abort.signal.aborted) throw error;
          logger.warn('Sequence preview image unavailable', { error });
        }
      }
      const audioTracks: OpenedClip['audioTracks'] = [];
      let audioDuration = 0;
      for (const url of clip.audioUrls) {
        const input = new Input({
          formats: ALL_FORMATS,
          // data: / blob: takes are in memory and answer no Range request.
          source:
            url.startsWith('data:') || url.startsWith('blob:')
              ? new UrlSource(url)
              : createRangedSource(url),
        });
        inputs.push(input);
        const track = await input.getPrimaryAudioTrack();
        if (!track || !(await track.canDecode()))
          throw new Error(
            'Recorded dialogue cannot be decoded by this browser'
          );
        const duration =
          (await input.getDurationFromMetadata([track], {
            skipLiveWait: true,
          })) ?? (await input.computeDuration([track], { skipLiveWait: true }));
        if (!Number.isFinite(duration) || duration <= 0)
          throw new Error('Recorded dialogue has no playable duration');
        audioTracks.push({ track, offset: audioDuration });
        audioDuration += duration;
      }
      return {
        inputs,
        image,
        videoTrack: null,
        audioTracks,
        duration: audioDuration || clip.durationSeconds,
        dimensions: { width: clip.width, height: clip.height },
        codecProbe: null,
      };
    } catch (error) {
      for (const input of inputs) input.dispose();
      closeStill(image);
      throw error;
    }
  }

  /**
   * Same load path as shot-view `<img>`: an element decode, not `fetch` +
   * `createImageBitmap`. Canvas `fetch` needs CORS; fal preview URLs and
   * some stored stills don't send it, so the whole-sequence stitcher painted
   * "No image available" while the inspector still showed the frame.
   */
  private decodeStill(url: string): Promise<HTMLImageElement> {
    const img = new Image();
    img.decoding = 'async';
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        img.src = '';
        reject(this.abort.signal.reason ?? new Error('aborted'));
      };
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
      img.src = url;
      img
        .decode()
        .then(() => resolve(img))
        .catch(reject)
        .finally(() => this.abort.signal.removeEventListener('abort', onAbort));
    });
  }

  private async probeClip(input: Input, i: number): Promise<OpenedClip> {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error(`Clip ${i} has no video track`);
    }
    if (!(await videoTrack.canDecode())) {
      throw new Error(`Clip ${i} cannot be decoded by this browser`);
    }
    // Prefer container metadata — it's cheap and matches the player's
    // perceived end. `computeDuration()` scans every packet and on Kling /
    // ffmpeg-generated MP4s can over-report by ~2× when the timebase or
    // edit-list isn't what it expects (#742).
    const metaDuration = await input.getDurationFromMetadata([videoTrack], {
      skipLiveWait: true,
    });
    const duration =
      metaDuration ??
      (await input.computeDuration([videoTrack], { skipLiveWait: true }));

    // Probe EVERY clip's display dimensions — different models emit
    // different sizes for the same aspect ratio (#791), so we can't assume
    // clip 0 is representative. A failed probe (0/NaN) must not silently
    // corrupt the target resolution downstream.
    const width = await videoTrack.getDisplayWidth();
    const height = await videoTrack.getDisplayHeight();
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < 1 ||
      height < 1
    ) {
      throw new Error(
        `Clip ${i} reported invalid dimensions ${width}×${height}; cannot stitch.`
      );
    }

    // Probe transmux-safety inputs; the verdict is computed once in `prepare()`
    // after every clip is open (see `canTransmuxScenes`) and stored on
    // `meta.canTransmux`.
    const codec = await videoTrack.getCodec();
    const decoderConfig =
      codec === 'avc' ? await videoTrack.getDecoderConfig() : null;
    const codecProbe: SceneCodecProbe = {
      codec,
      descriptionHex: decoderConfig
        ? decoderConfigDescriptionHex(decoderConfig)
        : '',
    };

    // Embedded clip audio (dialogue / VO). Best-effort: clips without an
    // audio track or with an undecodable codec are silent; the rest are
    // mixed by the player + export.
    const audioTrack = await input.getPrimaryAudioTrack();
    const usableAudio =
      audioTrack && (await audioTrack.canDecode()) ? audioTrack : null;

    return {
      inputs: [input],
      image: null,
      videoTrack,
      audioTracks: usableAudio ? [{ track: usableAudio, offset: 0 }] : [],
      duration,
      dimensions: { width, height },
      codecProbe,
    };
  }

  getMeta(): ConcatenatedVideoMeta {
    if (!this.meta) {
      throw new Error(
        'ConcatenatedVideoSource: prepare() must be called first'
      );
    }
    return this.meta;
  }

  /**
   * Map a global timeline time to a specific clip + local time. Clamps to the
   * last clip's end when `globalTime >= totalDuration`.
   */
  locate(globalTime: number): ClipSlice {
    const meta = this.getMeta();
    const time = Math.max(0, globalTime);
    for (let i = meta.clipOffsetsSeconds.length - 1; i >= 0; i--) {
      const offset = meta.clipOffsetsSeconds[i];
      if (offset === undefined) continue;
      if (time >= offset) {
        return { clipIndex: i, localTime: time - offset };
      }
    }
    return { clipIndex: 0, localTime: 0 };
  }

  /**
   * Read the opening second of clip `clipIndex`'s video so its bytes are in
   * the range reader's cache before the playhead crosses into it — the first
   * frame of a clip is otherwise a cold fetch at the cut. Stills have
   * nothing to read.
   */
  async prefetch(clipIndex: number): Promise<void> {
    const track = this.videoTracks[clipIndex];
    if (!track) return;
    const sink = new EncodedPacketSink(track);
    for await (const packet of sink.packets()) {
      if (this.disposed || packet.timestamp >= PREFETCH_SECONDS) return;
    }
  }

  /**
   * Live-playback iterator: yields `WrappedCanvas` frames starting at
   * `globalTime`, transparently rolling over from clip N to clip N+1 with
   * the timestamp re-anchored to the global timeline.
   *
   * Honors `signal` for cancellation between clips and between frames.
   */
  async *canvases(
    globalTime: number,
    options: {
      poolSize?: number;
      fit?: CanvasFit;
      signal?: AbortSignal;
    } = {}
  ): AsyncGenerator<WrappedCanvas, void, unknown> {
    const { poolSize = 2, fit = 'contain', signal } = options;
    const meta = this.getMeta();
    const { clipIndex: startClipIndex, localTime: startLocalTime } =
      this.locate(globalTime);

    for (
      let clipIndex = startClipIndex;
      clipIndex < this.videoTracks.length;
      clipIndex++
    ) {
      if (signal?.aborted) return;

      const videoTrack = this.videoTracks[clipIndex];
      const offset = meta.clipOffsetsSeconds[clipIndex];
      if (offset === undefined) continue;
      if (!videoTrack) {
        const canvas = document.createElement('canvas');
        canvas.width = meta.displayWidth;
        canvas.height = meta.displayHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Still playback needs a canvas context');
        const image = this.images[clipIndex];
        if (image) {
          const scale = Math.min(
            canvas.width / image.width,
            canvas.height / image.height
          );
          const width = image.width * scale;
          const height = image.height * scale;
          context.drawImage(
            image,
            (canvas.width - width) / 2,
            (canvas.height - height) / 2,
            width,
            height
          );
        } else {
          context.fillStyle = '#09090b';
          context.fillRect(0, 0, canvas.width, canvas.height);
        }
        const duration = meta.clipDurationsSeconds[clipIndex] ?? 0;
        const localStart =
          clipIndex === startClipIndex ? Math.min(startLocalTime, duration) : 0;
        yield {
          canvas,
          timestamp: offset + localStart,
          duration: duration - localStart,
        };
        // The engine prefetches one frame and ends when the iterator exhausts.
        // A final boundary frame keeps the last still alive for its entire hold.
        if (clipIndex === this.videoTracks.length - 1 && !signal?.aborted) {
          yield { canvas, timestamp: offset + duration, duration: 0 };
        }
        continue;
      }
      // Pin every clip to the common target size so mixed-resolution clips
      // (#791) are letterboxed into one canvas instead of being drawn at their
      // own size and clipped/misaligned. For a uniform sequence target ===
      // the clip's own size, so this is a no-op.
      const sink = new CanvasSink(videoTrack, {
        poolSize,
        fit,
        width: meta.displayWidth,
        height: meta.displayHeight,
      });
      const localStart = clipIndex === startClipIndex ? startLocalTime : 0;

      const iterator = sink.canvases(localStart);
      try {
        for await (const frame of iterator) {
          if (signal?.aborted) return;
          yield {
            ...frame,
            timestamp: frame.timestamp + offset,
            duration: frame.duration,
          };
        }
      } finally {
        // Swallow cleanup rejections so they can't clobber an in-flight
        // decode error — the original throw is the one worth surfacing.
        await iterator.return().catch((err: unknown) => {
          logger.warn(
            `ConcatenatedVideoSource: canvas iterator cleanup failed for clip ${clipIndex}`,
            { err }
          );
        });
      }
    }
  }

  /**
   * Export iterator: yields raw `EncodedPacket`s with offset timestamps,
   * suitable for feeding to `EncodedVideoPacketSource.add()` in the export
   * pipeline. Transmux-compatibility is decided once in `prepare()` (stored
   * on `meta.canTransmux`); this refuses to run when it's false rather than
   * re-deriving the verdict, so the two code paths can't drift.
   */
  async *packets(
    options: { signal?: AbortSignal } = {}
  ): AsyncGenerator<
    { packet: EncodedPacket; decoderConfig: VideoDecoderConfig | null },
    void,
    unknown
  > {
    const { signal } = options;
    const meta = this.getMeta();

    if (!meta.canTransmux) {
      throw new Error(
        'ConcatenatedVideoSource.packets(): clips are not transmux-compatible (mixed codecs or decoder configs); use the re-encode path instead.'
      );
    }

    let firstPacketEmitted = false;

    for (let clipIndex = 0; clipIndex < this.videoTracks.length; clipIndex++) {
      if (signal?.aborted) return;

      const videoTrack = this.videoTracks[clipIndex];
      const offset = meta.clipOffsetsSeconds[clipIndex];
      if (!videoTrack || offset === undefined) continue;

      // Only the first emitted packet carries the decoder config; the
      // canTransmux gate above guarantees every clip's config is identical.
      const decoderConfig = firstPacketEmitted
        ? null
        : await videoTrack.getDecoderConfig();

      const sink = new EncodedPacketSink(videoTrack);
      for await (const packet of sink.packets()) {
        if (signal?.aborted) return;
        const offsetTimestamp = packet.timestamp + offset;
        const offsetPacket = new EncodedPacket(
          packet.data,
          packet.type,
          offsetTimestamp,
          packet.duration,
          undefined,
          packet.byteLength,
          packet.sideData
        );
        yield {
          packet: offsetPacket,
          decoderConfig: firstPacketEmitted ? null : decoderConfig,
        };
        firstPacketEmitted = true;
      }
    }
  }

  /**
   * Audio tracks discovered during `prepare()`, paired with their global
   * clip offset. Clips without a usable audio track are omitted, so the
   * length may be smaller than `clips.length`.
   */
  getClipAudioTracks(): ClipAudioTrack[] {
    const meta = this.getMeta();
    const result: ClipAudioTrack[] = [];
    for (let i = 0; i < this.audioTracks.length; i++) {
      const tracks = this.audioTracks[i];
      const offset = meta.clipOffsetsSeconds[i];
      if (!tracks || offset === undefined) continue;
      for (const audio of tracks) {
        result.push({
          clipIndex: i,
          clipOffsetSeconds: offset + audio.offset,
          track: audio.track,
          isStill: !this.videoTracks[i],
        });
      }
    }
    return result;
  }

  /** Release every underlying `Input` — call when the source is no longer needed. */
  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    for (const image of this.images) closeStill(image);
    this.images = [];
    for (const input of this.inputs) input.dispose();
    this.inputs = [];
    this.videoTracks = [];
    this.audioTracks = [];
    this.meta = null;
  }
}
