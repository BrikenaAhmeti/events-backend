function partsInZone(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

export function eventLocalTimeToUtc(date: string, time: string, timezone: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    return undefined;
  const expectedText = `${date}T${time}`;
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0] =
    expectedText.split(/[-T:]/).map(Number);
  const expected = Date.UTC(year, month - 1, day, hour, minute);
  let instant = expected;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const actualText = partsInZone(new Date(instant), timezone);
      const [localYear = 0, localMonth = 0, localDay = 0, localHour = 0, localMinute = 0] =
        actualText.split(/[-T:]/).map(Number);
      instant += expected - Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute);
    }
    return partsInZone(new Date(instant), timezone) === expectedText
      ? new Date(instant).toISOString()
      : undefined;
  } catch {
    return undefined;
  }
}

export function eventTimeForReview(value: string, timezone: string): string {
  try { return `${partsInZone(new Date(value), timezone).replace('T', ' at ')} (${timezone})`; }
  catch { return value; }
}
