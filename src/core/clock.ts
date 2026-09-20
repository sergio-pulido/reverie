/**
 * `m:ss`, the one way this app writes a position or a duration.
 *
 * It floors and guards, because a playhead carries fractional seconds and a
 * counter that never arrived carries none at all. A script's whole seconds
 * pass through unchanged.
 */
export function formatClock(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
