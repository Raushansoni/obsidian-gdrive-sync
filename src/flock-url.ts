declare const __FLOCK_RELAY_URL__: string;

export const DEFAULT_RELAY_URL =
  typeof __FLOCK_RELAY_URL__ !== "undefined" && __FLOCK_RELAY_URL__
    ? __FLOCK_RELAY_URL__
    : "http://127.0.0.1:8787";
