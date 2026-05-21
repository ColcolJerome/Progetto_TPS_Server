export const CONFIG = {
  TCP_PORT: Number(process.env.TCP_PORT || 4000),
  UDP_PORT: Number(process.env.UDP_PORT || 4001),
  UI_PORT: Number(process.env.UI_PORT || 8080),
  WORLD_WIDTH: 4200,
  WORLD_HEIGHT: 4200,
  TICK_RATE: 60,
  SNAPSHOT_RATE: 30,
  LEADERBOARD_RATE: 2,
  FOOD_COUNT: 520,
  BOT_COUNT: Number(process.env.BOT_COUNT || 10),
  MAX_NAME_LENGTH: 16,
  START_RADIUS: 30,
  FOOD_RADIUS_MIN: 4,
  FOOD_RADIUS_MAX: 7,
  BASE_SPEED: 255,
  MIN_SPEED: 70,
  PLAYER_EAT_RATIO: 1.16,
  PLAYER_EAT_GAIN: 0.86,
  MASS_DECAY_PER_TICK: 0.000075,
  UDP_PACKET_LIMIT_BYTES: 60_000,
  MAX_CELLS_PER_PLAYER: 32,
  SPLIT_MIN_RADIUS: 20,
  SPLIT_IMPULSE: 760,
  SPLIT_COOLDOWN_MS: 650,
  MERGE_DELAY_MS: 10_000,
  EJECT_MIN_RADIUS: 20,
  EJECT_MASS: 42,
  EJECT_RADIUS: 7,
  EJECT_IMPULSE: 920,
  EJECT_COOLDOWN_MS: 90,
  EJECT_REABSORB_DELAY_MS: 700,
  EJECT_EAT_GAIN: 10,
  EJECT_MAX_COUNT: 180,
  CELL_LOSS_GRACE_MS: 450,
  BOT_ALLY_DURATION_MS: 12_000,
  BOT_ALLY_BETRAY_MIN_MS: 7_000,
  BOT_ALLY_BETRAY_MAX_MS: 16_000,
  BOT_SUPPORT_RADIUS: 560
};

export const COLORS = [
  '#ff6b6b', '#4ecdc4', '#ffe66d', '#5f27cd', '#54a0ff', '#ff9f43',
  '#10ac84', '#f368e0', '#00d2d3', '#ee5253', '#c8d6e5', '#1dd1a1'
];

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function rand(min, max) {
  return Math.random() * (max - min) + min;
}

export function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

export function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

export function sanitizeName(input, fallback = 'Blob') {
  const cleaned = String(input || fallback)
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .trim()
    .slice(0, CONFIG.MAX_NAME_LENGTH);
  return cleaned || fallback;
}
