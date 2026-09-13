import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { AiProvider } from '../../../infrastructure/openai/ai.provider';
import type { DocumentTextExtractorService } from '../../documents/application/document-text-extractor.service';
import type { FileValidationService } from '../../documents/application/file-validation.service';
import type { EventCompletenessService } from '../../events/domain/event-completeness.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { EventSetupAnalysisService } from './event-setup-analysis.service';

const clientId = '7f24fbca-c63c-4ea0-af61-c74390c238b9';

const actor: AuthenticatedActor = {
  userId: 'platform-admin',
  supabaseUserId: 'identity-a',
  email: 'admin@example.test',
  firstName: 'Platform',
  lastName: 'Admin',
  platformRole: 'SUPER_ADMIN',
  memberships: [],
};

describe('EventSetupAnalysisService', () => {
  it('validates the selected client and returns the next setup message', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: clientId, name: 'Northstar Events' });
    const service = new EventSetupAnalysisService(
      { client: { findUnique } } as unknown as PrismaService,
      new AuthorizationService(),
      {} as FileValidationService,
      {} as DocumentTextExtractorService,
      {} as AiProvider,
      {} as EventCompletenessService,
    );

    const result = await service.start(actor, { clientId });

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: clientId },
      select: { id: true, name: true },
    });
    expect(result).toEqual({
      clientId,
      clientName: 'Northstar Events',
      message:
        'Great — we’re setting up a new event for Northstar Events. Share everything you already know, or attach an event file, and I’ll organize the details for you.',
    });
  });

  it('returns the conversational reply produced by the backend model with prior context', async () => {
    const extractEventInformation = vi.fn().mockResolvedValue({
      reply: 'I captured the venue. What dates and organizer contact should I add?',
      event: { name: 'Leadership Forum', category: 'CONFERENCE', venue: 'Riverside Hall' },
      facts: [],
      schedule: [],
    });
    const completeness = {
      evaluate: vi.fn().mockReturnValue({
        score: 30,
        ready: false,
        missing: ['startAt'],
        warnings: [],
        recommendations: [],
      }),
    };
    const service = new EventSetupAnalysisService(
      {
        client: { findUnique: vi.fn().mockResolvedValue({ name: 'Northstar Events' }) },
      } as unknown as PrismaService,
      new AuthorizationService(),
      {} as FileValidationService,
      {} as DocumentTextExtractorService,
      { extractEventInformation } as unknown as AiProvider,
      completeness as unknown as EventCompletenessService,
    );

    const result = await service.analyze(
      actor,
      {
        clientId,
        text: 'The venue is Riverside Hall.',
        context: JSON.stringify({ event: { description: 'Annual leadership forum' } }),
      },
      undefined,
      'request-a',
    );

    expect(extractEventInformation).toHaveBeenCalledWith(
      expect.stringContaining('Latest event creator message:\nThe venue is Riverside Hall.'),
      'request-a',
    );
    expect(extractEventInformation).toHaveBeenCalledWith(
      expect.stringContaining('Previously reviewed event context:'),
      'request-a',
    );
    expect(result.message).toBe(
      'I captured the venue. What dates and organizer contact should I add?',
    );
  });
});
