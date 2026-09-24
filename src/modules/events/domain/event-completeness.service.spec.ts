import { EventCompletenessService } from './event-completeness.service';

describe('EventCompletenessService', () => {
  const service = new EventCompletenessService();

  it('rejects a past start for new event setup without changing existing-event completeness', () => {
    const event = {
      name: 'Past gathering', category: 'OTHER', description: 'A completed gathering.',
      destination: 'Lisbon', venue: null,
      startAt: new Date(Date.now() - 3_600_000),
      endAt: new Date(Date.now() + 3_600_000),
      timezone: 'Europe/Lisbon', organizerName: 'Morgan Reed',
      organizerEmail: 'morgan@example.test',
    };
    expect(service.evaluate(event).ready).toBe(true);
    expect(service.evaluate(event, { requireFutureStart: true })).toMatchObject({
      ready: false, warnings: ['startInPast'],
    });
  });

  it('marks a fully valid event ready', () => {
    const result = service.evaluate({
      name: 'Presidents Club Mallorca',
      category: 'CORPORATE_INCENTIVE',
      description: 'A recognition journey',
      destination: 'Mallorca',
      venue: null,
      startAt: new Date('2027-06-10T10:00:00Z'),
      endAt: new Date('2027-06-14T10:00:00Z'),
      timezone: 'Europe/Madrid',
      organizerName: 'Northstar Guest Services',
      organizerEmail: 'events@example.test',
    });
    expect(result).toMatchObject({ score: 100, ready: true, missing: [], warnings: [] });
  });

  it('reports missing fields and invalid date order deterministically', () => {
    const result = service.evaluate({
      name: 'Draft event',
      category: 'OTHER',
      description: null,
      destination: null,
      venue: null,
      startAt: new Date('2027-06-14T10:00:00Z'),
      endAt: new Date('2027-06-10T10:00:00Z'),
      timezone: 'Invalid/Zone',
      organizerName: null,
      organizerEmail: null,
    });
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(['description', 'location', 'organizerName', 'organizerEmail']);
    expect(result.warnings).toEqual(['endBeforeStart', 'invalidTimezone']);
  });
});
