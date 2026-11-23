export const PLAY_MODES = ["direct", "hls"] as const;
export type PlayMode = (typeof PLAY_MODES)[number];
export const DEFAULT_PLAY_MODE: PlayMode = "hls";
