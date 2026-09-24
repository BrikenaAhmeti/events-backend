import { EventStatus } from '@prisma/client';
import { GuestAccessWindowService } from './guest-access-window.service';

describe('GuestAccessWindowService', () => {
  const service = new GuestAccessWindowService();
  const event = {
    status: EventStatus.PUBLISHED,
    startAt: new Date('2027-06-10T10:00:00Z'),
    endAt: new Date('2027-06-10T18:00:00Z'),
  };

  it('opens before the event after publication and closes four hours after it ends', () => {
    expect(service.state(event, new Date('2027-06-09T09:59:59Z'))).toBe('ACTIVE');
    expect(service.state(event, new Date('2027-06-10T09:59:59Z'))).toBe('ACTIVE');
    expect(service.state(event, new Date('2027-06-10T10:00:00Z'))).toBe('ACTIVE');
    expect(service.state(event, new Date('2027-06-10T21:59:59Z'))).toBe('ACTIVE');
    expect(service.state(event, new Date('2027-06-10T22:00:00Z'))).toBe('ENDED');
  });

  it('never opens cancelled events', () => {
    expect(
      service.state({ ...event, status: EventStatus.CANCELLED }, new Date('2027-06-10T12:00:00Z')),
    ).toBe('CANCELLED');
  });
});
