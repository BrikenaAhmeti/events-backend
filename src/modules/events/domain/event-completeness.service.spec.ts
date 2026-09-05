import { EventCompletenessService } from './event-completeness.service';

describe('EventCompletenessService', () => {
  const service = new EventCompletenessService();

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
