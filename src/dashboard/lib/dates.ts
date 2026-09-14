import { dashboardConfig } from './config';

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: dashboardConfig.timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
export function dateBounds(day: string, timezone = dashboardConfig.timezone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Choose a valid date.');
  const date = new Date(`${day}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== day
  )
    throw new Error('Choose a valid date.');
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  function midnightUtc(target: number) {
    let guess = target;
    for (let attempt = 0; attempt < 3; attempt++) {
      const parts = Object.fromEntries(
        formatter
          .formatToParts(new Date(guess))
          .map((part) => [part.type, part.value]),
      );
      const represented = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second),
      );
      const difference = target - represented;
      guess += difference;
      if (difference === 0) break;
    }
    return new Date(guess).toISOString();
  }
  return {
    start: midnightUtc(date.getTime()),
    end: midnightUtc(date.getTime() + 86400000),
  };
}
