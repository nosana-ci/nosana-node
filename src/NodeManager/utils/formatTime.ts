/**
 * Converts seconds into a formatted time string (e.g., "1h 23m 45s", "5m 30s", "45s")
 * @param seconds - The number of seconds to format
 * @returns Formatted time string with hours, minutes, and/or seconds
 */
export function formatTime(seconds: number): string {
  const totalSeconds = Math.floor(seconds);

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${secs}s`);

  return parts.join(' ');
}
