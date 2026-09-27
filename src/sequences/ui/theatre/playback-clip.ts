/** One stitched theatre entry: a rendered clip, or a timed still. */
export type PlaybackClip = {
  orderIndex: number;
} & (
  | {
      videoUrl: string;
      /**
       * The shot's still — what the clip opens on — shown while the player
       * warms up. Not the clip itself: a hidden `<video>` would download it
       * beside the player's own reads.
       */
      posterUrl: string | null;
    }
  | {
      imageUrl: string | null;
      fallbackImageUrl: string | null;
      durationSeconds: number;
      audioUrls: string[];
      width: number;
      height: number;
    }
);
