import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { AiProvider } from '../../../infrastructure/openai/ai.provider';
import type { FileStorage } from '../../../infrastructure/storage/file-storage';
import type { DocumentTextExtractorService } from '../../documents/application/document-text-extractor.service';
import type { FileValidationService } from '../../documents/application/file-validation.service';
import type { EventCompletenessService } from '../../events/domain/event-completeness.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { EventSetupAnalysisService } from './event-setup-analysis.service';

const clientId = '7f24fbca-c63c-4ea0-af61-c74390c238b9';
const sessionId = '9f47fbca-c63c-4ea0-af61-c74390c238b8';

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
  it('starts a persisted setup conversation that invites event and guest details directly', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: clientId, name: 'Northstar Events' });
    const createConversation = vi.fn().mockResolvedValue({
      id: sessionId,
      draft: {},
      setupDocuments: [],
      messages: [
        {
          id: 'welcome-a',
          role: 'CONCIERGE',
          content:
            'Let’s set up a new event for Northstar Events. Tell me what you know about its purpose, dates, location, and organizer. You can add guest names and email addresses here too.',
          metadata: {},
          createdAt: new Date('2027-01-01T10:00:00Z'),
        },
      ],
    });
    const service = new EventSetupAnalysisService(
      {
        client: { findUnique },
        conversation: { findFirst: vi.fn().mockResolvedValue(null), create: createConversation },
      } as unknown as PrismaService,
      new AuthorizationService(),
      {} as FileValidationService,
      {} as DocumentTextExtractorService,
      {} as AiProvider,
      {} as EventCompletenessService,
      {} as FileStorage,
    );

    const result = await service.start(actor, { clientId });

    expect(result.sessionId).toBe(sessionId);
    expect(result.resumed).toBe(false);
    expect(result.messages[0]?.content).toContain('guest names and email addresses');
    const createInput = createConversation.mock.calls[0]?.[0] as unknown as {
      data: { type: string; userId: string };
    };
    expect(createInput.data.type).toBe('EVENT_SETUP');
    expect(createInput.data.userId).toBe(actor.userId);
  });

  it('resumes the active setup and archives it when a new chat is requested', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const create = vi.fn().mockResolvedValue({
      id: sessionId,
      draft: {},
      setupDocuments: [],
      messages: [],
    });
    const service = new EventSetupAnalysisService(
      {
        client: {
          findUnique: vi.fn().mockResolvedValue({ id: clientId, name: 'Northstar Events' }),
        },
        conversation: { updateMany, create },
      } as unknown as PrismaService,
      new AuthorizationService(),
      {} as FileValidationService,
      {} as DocumentTextExtractorService,
      {} as AiProvider,
      {} as EventCompletenessService,
      {} as FileStorage,
    );

    await service.start(actor, { clientId, restart: true });

    const archiveInput = updateMany.mock.calls[0]?.[0] as unknown as {
      where: { type: string; state: string };
      data: { state: string };
    };
    expect(archiveInput.where).toMatchObject({ type: 'EVENT_SETUP', state: 'ACTIVE' });
    expect(archiveInput.data.state).toBe('ARCHIVED');
    expect(create).toHaveBeenCalledOnce();
  });

  it('offers a persisted fillable template when the creator asks for one', async () => {
    const createMessage = vi
      .fn<
        (input: {
          data: { role: string; metadata?: { setupTemplate: string }; [key: string]: unknown };
        }) => Promise<Record<string, unknown>>
      >()
      .mockImplementation(({ data }) =>
        Promise.resolve({ id: `message-${data.role}`, ...data, createdAt: new Date() }),
      );
    const extractEventInformation = vi.fn();
    const service = new EventSetupAnalysisService(
      {
        client: { findUnique: vi.fn().mockResolvedValue({ name: 'Northstar Events' }) },
        conversation: {
          findFirst: vi.fn().mockResolvedValue({
            id: sessionId,
            clientId,
            draft: {},
            setupDocuments: [],
            messages: [],
          }),
        },
        conversationMessage: { create: createMessage },
      } as unknown as PrismaService,
      new AuthorizationService(),
      {} as FileValidationService,
      {} as DocumentTextExtractorService,
      { extractEventInformation } as unknown as AiProvider,
      {
        evaluate: vi.fn().mockReturnValue({
          score: 0,
          ready: false,
          missing: ['name'],
          warnings: [],
          recommendations: [],
        }),
      } as unknown as EventCompletenessService,
      {} as FileStorage,
    );

    const result = await service.analyze(
      actor,
      { clientId, sessionId, text: 'template' },
      undefined,
      'request-template',
    );

    expect(result.template).toEqual({
      kind: 'EVENT_BRIEF',
      fileName: 'feliam-event-brief-template.docx',
    });
    expect(createMessage.mock.calls[1]?.[0].data.metadata).toEqual({
      setupTemplate: 'EVENT_BRIEF',
    });
    expect(extractEventInformation).not.toHaveBeenCalled();
  });

  it('stores the model reply, merged setup state, and the next missing-detail question', async () => {
    const extractEventInformation = vi.fn().mockResolvedValue({
      reply: 'I captured the venue.',
      event: { name: 'Leadership Forum', category: 'CONFERENCE', venue: 'Riverside Hall' },
      facts: [],
      schedule: [],
      guests: [
        { fullName: 'Alex Morgan', email: 'alex@example.test' },
        { fullName: 'Sam Lee', email: null },
      ],
    });
    const completenessResult = {
      score: 33,
      ready: false,
      missing: ['startAt'],
      warnings: [],
      recommendations: [],
    };
    const updateConversation = vi.fn().mockResolvedValue({ id: sessionId });
    const createAssistant = vi.fn().mockImplementation(({ data }) =>
      Promise.resolve({ id: 'assistant-a', ...data, createdAt: new Date() }),
    );
    const createUser = vi.fn().mockResolvedValue({
      id: 'user-a',
      role: 'USER',
      content: 'The venue is Riverside Hall.',
    });
    const transaction = {
      conversation: { update: updateConversation },
      conversationMessage: { create: createAssistant },
    };
    const service = new EventSetupAnalysisService(
      {
        client: { findUnique: vi.fn().mockResolvedValue({ name: 'Northstar Events' }) },
        conversation: {
          findFirst: vi.fn().mockResolvedValue({
            id: sessionId,
            clientId,
            draft: { event: { description: 'Annual leadership forum' } },
            setupDocuments: [],
            messages: [
              {
                role: 'CONCIERGE',
                content: 'What venue should I add for this event?',
                createdAt: new Date('2027-01-01T10:00:00Z'),
              },
            ],
          }),
        },
        conversationMessage: { create: createUser },
        $transaction: vi.fn((work: (value: typeof transaction) => unknown) =>
          work(transaction),
        ),
      } as unknown as PrismaService,
      new AuthorizationService(),
      {} as FileValidationService,
      {} as DocumentTextExtractorService,
      { extractEventInformation } as unknown as AiProvider,
      { evaluate: vi.fn().mockReturnValue(completenessResult) } as unknown as EventCompletenessService,
      {} as FileStorage,
    );

    const result = await service.analyze(
      actor,
      {
        clientId,
        sessionId,
        text: 'The venue is Riverside Hall.',
        startAt: '2027-10-12T08:00:00.000Z',
        endAt: '2027-10-12T18:00:00.000Z',
        timezone: 'Europe/Lisbon',
      },
      undefined,
      'request-a',
    );

    expect(extractEventInformation).toHaveBeenCalledWith(
      expect.stringContaining('Previously confirmed event setup state:'),
      'request-a',
    );
    expect(extractEventInformation).toHaveBeenCalledWith(
      expect.stringContaining('Concierge: What venue should I add for this event?'),
      'request-a',
    );
    expect(result.event).toMatchObject({
      name: 'Leadership Forum',
      description: 'Annual leadership forum',
      venue: 'Riverside Hall',
      startAt: '2027-10-12T08:00:00.000Z',
      endAt: '2027-10-12T18:00:00.000Z',
      timezone: 'Europe/Lisbon',
    });
    expect(result.message).toBe(
      'I captured the venue. Choose the start and end date and time below. I’ll include your local timezone.',
    );
    expect(result.guests).toEqual([{ fullName: 'Alex Morgan', email: 'alex@example.test' }]);
    expect(updateConversation).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: sessionId } }),
    );
  });

  it('stores an uploaded setup file and its extracted text before the event exists', async () => {
    const documentCreate = vi
      .fn<(input: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>>()
      .mockResolvedValue({
        id: 'document-a',
        originalName: 'event-plan.txt',
        size: 62,
      });
    const transaction = {
      document: { create: documentCreate },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-a' }) },
      conversation: { update: vi.fn().mockResolvedValue({ id: sessionId }) },
      conversationMessage: {
        create: vi.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: 'assistant-a', ...data, createdAt: new Date() }),
        ),
      },
    };
    const storage = {
      upload: vi.fn().mockResolvedValue({ objectKey: 'stored/event-plan.txt', bucket: 'events' }),
      delete: vi.fn(),
    };
    const service = new EventSetupAnalysisService(
      {
        client: { findUnique: vi.fn().mockResolvedValue({ name: 'Northstar Events' }) },
        conversation: {
          findFirst: vi.fn().mockResolvedValue({
            id: sessionId,
            clientId,
            draft: {},
            setupDocuments: [],
          }),
        },
        conversationMessage: {
          create: vi.fn().mockResolvedValue({ id: 'user-a', role: 'USER' }),
        },
        document: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn((work: (value: typeof transaction) => unknown) => work(transaction)),
      } as unknown as PrismaService,
      new AuthorizationService(),
      { validate: vi.fn().mockReturnValue('txt') },
      {
        extract: vi.fn().mockResolvedValue({
          text: 'Leadership forum at Riverside Hall. Organizer details to follow.',
          metadata: { characters: 62 },
        }),
      } as unknown as DocumentTextExtractorService,
      {
        extractEventInformation: vi.fn().mockResolvedValue({
          reply: 'I found the venue. What is the event start date and time?',
          event: { venue: 'Riverside Hall' },
          facts: [],
          schedule: [],
        }),
      } as unknown as AiProvider,
      {
        evaluate: vi.fn().mockReturnValue({
          score: 11,
          ready: false,
          missing: ['name'],
          warnings: [],
          recommendations: [],
        }),
      } as unknown as EventCompletenessService,
      storage as unknown as FileStorage,
    );
    const file = {
      originalname: 'event-plan.txt',
      mimetype: 'text/plain',
      size: 62,
      buffer: Buffer.from('Leadership forum at Riverside Hall. Organizer details to follow.'),
    } as Express.Multer.File;

    const result = await service.analyze(
      actor,
      { clientId, sessionId },
      file,
      'request-file',
    );

    expect(storage.upload).toHaveBeenCalledOnce();
    const documentInput = documentCreate.mock.calls[0]?.[0];
    expect(documentInput?.data).toMatchObject({
      setupConversationId: sessionId,
      processingStatus: 'PENDING',
    });
    expect(documentInput?.data.extraction).toBeDefined();
    expect(documentInput?.data).not.toHaveProperty('eventId');
    expect(result.file).toEqual({ id: 'document-a', name: 'event-plan.txt', size: 62 });
  });
});
