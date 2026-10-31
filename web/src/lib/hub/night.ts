/** "22:00-06:30" → whether `now` (in `timezone`) falls inside it, wrapping midnight. */
export function inWindow(window: string, now: Date, timezone: string): boolean {
  const m = window.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const [h, mi] = now.toLocaleTimeString("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).split(":").map(Number);
  const minutes = h * 60 + mi;
  const start = +m[1] * 60 + +m[2];
  const end = +m[3] * 60 + +m[4];
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
