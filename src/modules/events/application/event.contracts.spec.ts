import { eventListQuerySchema } from './event.contracts';

describe('eventListQuerySchema', () => {
  it('accepts comma-separated and repeated multi-value filters', () => {
    expect(
      eventListQuerySchema.parse({
        lifecycle: 'UPCOMING, ONGOING',
        status: ['READY', 'PUBLISHED'],
      }),
    ).toMatchObject({
      lifecycle: ['UPCOMING', 'ONGOING'],
      status: ['READY', 'PUBLISHED'],
      limit: 20,
    });
  });

  it('deduplicates filter values and rejects unknown values', () => {
    expect(eventListQuerySchema.parse({ status: 'READY,READY' }).status).toEqual(['READY']);
    expect(() => eventListQuerySchema.parse({ lifecycle: 'UPCOMING,UNKNOWN' })).toThrow();
  });
});
