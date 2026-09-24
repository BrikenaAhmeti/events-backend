import { describe, expect, it } from 'vitest';
import { eventLocalTimeToUtc, eventTimeForReview } from './event-local-time';

describe('event local time normalization', () => {
  it('converts a one-day schedule and a multi-day range in the event timezone', () => {
    expect(eventLocalTimeToUtc('2027-10-12', '09:30', 'Europe/Lisbon'))
      .toBe('2027-10-12T08:30:00.000Z');
    expect(eventLocalTimeToUtc('2027-10-13', '17:45', 'Europe/Lisbon'))
      .toBe('2027-10-13T16:45:00.000Z');
    expect(eventTimeForReview('2027-10-12T08:30:00.000Z', 'Europe/Lisbon'))
      .toBe('2027-10-12 at 09:30 (Europe/Lisbon)');
  });

  it('does not invent an instant for invalid dates, times, or timezone gaps', () => {
    expect(eventLocalTimeToUtc('2027-02-30', '09:00', 'UTC')).toBeUndefined();
    expect(eventLocalTimeToUtc('2027-10-12', '25:00', 'UTC')).toBeUndefined();
    expect(eventLocalTimeToUtc('2027-03-28', '02:30', 'Europe/Belgrade')).toBeUndefined();
  });
});
