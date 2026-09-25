import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { AiProvider } from '../../../infrastructure/openai/ai.provider';
import type { FileStorage } from '../../../infrastructure/storage/file-storage';
import type { DocumentTextExtractorService } from '../../documents/application/document-text-extractor.service';
import type { FileValidationService } from '../../documents/application/file-validation.service';
import { EventCompletenessService } from '../../events/domain/event-completeness.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';
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
  it('asks for a new date when chat extracts an event start in the past', async () => {
    const startAt = new Date(Date.now() - 3_600_000).toISOString();
    const endAt = new Date(Date.now() + 3_600_000).toISOString();
    const transaction = {
      conversation: { update: vi.fn().mockResolvedValue({ id: sessionId }) },
      conversationMessage: { create: vi.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'message-a', ...data })) },
    };
    const service = new EventSetupAnalysisService({
      client: { findUnique: vi.fn().mockResolvedValue({ name: 'Northstar Events' }) },
      conversation: { findFirst: vi.fn().mockResolvedValue({
        id: sessionId, draft: {}, setupDocuments: [], messages: [],
      }) },
      conversationMessage: { create: transaction.conversationMessage.create },
      $transaction: vi.fn((work: (value: typeof transaction) => unknown) => work(transaction)),
    } as unknown as PrismaService, new AuthorizationService(), {} as FileValidationService,
    {} as DocumentTextExtractorService, {
      extractEventInformation: vi.fn().mockResolvedValue({
        reply: 'I found the event details.', nameSuggestions: [],
        event: { name: 'Past Gathering', category: 'OTHER',
          description: 'A gathering with a past start time.', destination: 'Lisbon',
          startAt, endAt, timezone: 'Europe/Lisbon',
          organizerName: 'Morgan Reed', organizerEmail: 'morgan@example.test' },
        facts: [], schedule: [], guests: [],
      }),
    } as unknown as AiProvider, new EventCompletenessService(), {} as FileStorage);

    const result = await service.analyze(actor, {
      clientId, sessionId, text: 'The event started an hour ago.',
    }, undefined, 'request-past');
    expect(result.completeness.ready).toBe(false);
    expect(result.completeness.warnings).toContain('startInPast');
    expect(result.message).toContain('The start time is in the past');
  });

  it('suggests names and infers a memorial type from the goal, then preserves other details during a correction', async () => {
    let draft: Record<string, unknown> = {};
    const extractEventInformation = vi.fn()
      .mockResolvedValueOnce({
        reply: 'I can suggest names for this commemoration.',
        nameSuggestions: ['In Their Memory', 'Remembering Freedom', 'Prishtina Remembers'],
        event: {
          category: 'MEMORIAL',
          description: 'A commemoration of people killed in the war for freedom.',
          destination: 'Prishtina',
        },
        facts: [], schedule: [], guests: [],
      })
      .mockResolvedValueOnce({
        reply: 'I changed the location.', nameSuggestions: [],
        event: { destination: 'Gjakova' },
        facts: [], schedule: [], guests: [],
      });
    const transaction = {
      conversation: { update: vi.fn(({ data }: { data: { draft: Record<string, unknown> } }) => {
        draft = data.draft;
        return Promise.resolve({ id: sessionId });
      }) },
      conversationMessage: { create: vi.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'message-a', ...data })) },
    };
    const service = new EventSetupAnalysisService({
      client: { findUnique: vi.fn().mockResolvedValue({ name: 'Northstar Events' }) },
      conversation: { findFirst: vi.fn(() => Promise.resolve({
        id: sessionId, draft, setupDocuments: [], messages: [],
      })) },
      conversationMessage: { create: transaction.conversationMessage.create },
      $transaction: vi.fn((work: (value: typeof transaction) => unknown) => work(transaction)),
    } as unknown as PrismaService, new AuthorizationService(), {} as FileValidationService,
    {} as DocumentTextExtractorService, { extractEventInformation } as unknown as AiProvider,
    new EventCompletenessService(), {} as FileStorage);

    const proposed = await service.analyze(actor, {
      clientId, sessionId,
      text: 'Please suggest a meaningful name for remembering people killed in the war for freedom in Prishtina.',
    }, undefined, 'request-goal');
    expect(proposed.event.name).toBeUndefined();
    expect(proposed.event.category).toBe('MEMORIAL');
    expect(proposed.nameSuggestions).toEqual(['In Their Memory', 'Remembering Freedom', 'Prishtina Remembers']);
    expect(proposed.message).toContain('Choose one below or write your own');

    const chosen = await service.analyze(actor, {
      clientId, sessionId, nameDecision: 'accept', eventName: 'Prishtina Remembers',
    }, undefined, 'request-name');
    expect(chosen.event.name).toBe('Prishtina Remembers');
    const clarification = await service.analyze(actor, {
      clientId, sessionId, text: 'No',
    }, undefined, 'request-no');
    expect(clarification.message).toContain('What should I change?');
    expect(extractEventInformation).toHaveBeenCalledTimes(1);
    const corrected = await service.analyze(actor, {
      clientId, sessionId, text: 'No, change the location to Gjakova.',
    }, undefined, 'request-correction');
    expect(corrected.event).toMatchObject({
      name: 'Prishtina Remembers', category: 'MEMORIAL', destination: 'Gjakova',
    });
    expect(extractEventInformation).toHaveBeenCalledTimes(2);
  });

  it.each(['accept', 'reject'] as const)('persists an explicit name decision (%s) without model interpretation', async (decision) => {
    let draft: Record<string, unknown> = {
      event: { description: 'An annual leadership gathering.', category: 'CONFERENCE' },
      suggestedName: 'Northstar Conference',
    };
    const extractEventInformation = vi.fn();
    const transaction = {
      conversation: { update: vi.fn(({ data }: { data: { draft: Record<string, unknown> } }) => {
        draft = data.draft;
        return Promise.resolve({ id: sessionId });
      }) },
      conversationMessage: { create: vi.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'message-a', ...data })) },
    };
    const service = new EventSetupAnalysisService({
      client: { findUnique: vi.fn().mockResolvedValue({ name: 'Northstar' }) },
      conversation: { findFirst: vi.fn(() => Promise.resolve({ id: sessionId, draft, setupDocuments: [], messages: [] })) },
      $transaction: vi.fn((work: (value: typeof transaction) => unknown) => work(transaction)),
    } as unknown as PrismaService, new AuthorizationService(), {} as FileValidationService,
    {} as DocumentTextExtractorService, { extractEventInformation } as unknown as AiProvider,
    new EventCompletenessService(), {} as FileStorage);

    const result = await service.analyze(actor, { clientId, sessionId, nameDecision: decision }, undefined, 'request-name');
    expect(result.nameSuggestionRejected).toBe(decision === 'reject');
    if (decision === 'accept') {
      expect(result.event.name).toBe('Northstar Conference');
      expect(result.completeness.missing).not.toContain('name');
    } else {
      expect(result.event.name).toBeUndefined();
      expect(result.message).toContain('Enter the event name');
      const renamed = await service.analyze(actor, { clientId, sessionId, eventName: 'My annual forum' }, undefined, 'request-custom-name');
      expect(renamed.event.name).toBe('My annual forum');
      expect(renamed.nameSuggestionRejected).toBe(false);
      expect(renamed.completeness.missing).not.toContain('name');
    }
    expect(extractEventInformation).not.toHaveBeenCalled();
  });
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
            'Let’s set up a new event for Northstar Events. First, tell me its purpose, event type, and name if you have one. You can also add the location, organizer, and guest names and email addresses, or attach a file. After the basics, I’ll show a separate date step with a calendar and time controls.',
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
    expect(result.messages[0]?.content).toContain('separate date step with a calendar');
    const createInput = createConversation.mock.calls[0]?.[0] as unknown as {
      data: { type: string; userId: string; messages: { create: { content: string } } };
    };
    expect(createInput.data.type).toBe('EVENT_SETUP');
    expect(createInput.data.messages.create.content).toContain('I’ll work out its type');
    expect(createInput.data.messages.create.content).toContain('I’ll suggest a few');
    expect(createInput.data.userId).toBe(actor.userId);
    expect(createInput.data.messages.create.content).toContain('separate date step with a calendar');
  });

  it('shows the separate date step when reopening a chat with the old welcome', async () => {
    const oldWelcome = 'Let’s set up a new event for Northstar Events. Tell me what you know about its purpose, dates, location, and organizer. You can add guest names and email addresses here too. Send everything in one message or several, or attach a file. I’ll ask for any required details that are missing.';
    const service = new EventSetupAnalysisService(
      {
        client: { findUnique: vi.fn().mockResolvedValue({ id: clientId, name: 'Northstar Events' }) },
        conversation: { findFirst: vi.fn().mockResolvedValue({
          id: sessionId, draft: {}, setupDocuments: [],
          messages: [
            { id: 'welcome-a', role: 'CONCIERGE', content: oldWelcome },
            { id: 'reply-a', role: 'USER', content: 'Our annual forum' },
          ],
        }) },
      } as unknown as PrismaService,
      new AuthorizationService(),
      {} as FileValidationService,
      {} as DocumentTextExtractorService,
      {} as AiProvider,
      {} as EventCompletenessService,
      {} as FileStorage,
    );

    const result = await service.start(actor, { clientId });
    expect(result.resumed).toBe(true);
    expect(result.messages[0]?.content).toContain('separate date step with a calendar');
    expect(result.messages[0]?.content).not.toContain('its purpose, dates, location');
    expect(result.messages[1]?.content).toBe('Our annual forum');
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

    expect('template' in result ? result.template : undefined).toEqual({
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
      event: {
        name: 'Leadership Forum', category: 'CONFERENCE', venue: 'Riverside Hall',
        organizerEmail: 'invalid email',
      },
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

    const staffCreator: AuthenticatedActor = {
      ...actor,
      platformRole: null,
      memberships: [{ clientId, role: 'CLIENT_STAFF', status: 'ACTIVE', permissions: [Permission.EVENT_CREATE] }],
    };
    const result = await service.analyze(
      staffCreator,
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
      expect.stringContaining('Current event setup draft'),
      'request-a',
      [],
      undefined,
    );
    expect(extractEventInformation).toHaveBeenCalledWith(
      expect.stringContaining('Concierge: What venue should I add for this event?'),
      'request-a',
      [],
      undefined,
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
      'I captured the venue. Next, check the known event dates and times, and fill in anything missing in the date step below. I still need email addresses before I can add these guests: Sam Lee.',
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
    const extract = vi.fn().mockResolvedValue({
      text: 'Conferencia en Riverside Hall. 12 octubre 2027, 09:00–18:00. Organización: Morgan Reed, morgan@example.test.',
      metadata: { characters: 110 },
    });
    const extractEventInformation = vi.fn()
      .mockResolvedValueOnce({
        reply: 'I found the venue.',
        event: { venue: 'Riverside Hall' },
        facts: [], schedule: [],
      })
      .mockResolvedValue({
        reply: 'I found the date, times, and organizer.',
        event: { startDate: '2027-10-12',
          endDate: '2027-10-12', startTime: '09:00', endTime: '18:00',
          timezone: 'Europe/Lisbon', organizerName: 'Morgan Reed',
          organizerEmail: 'morgan@example.test' },
        facts: [], schedule: [],
      });
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
      { extract } as unknown as DocumentTextExtractorService,
      { extractEventInformation } as unknown as AiProvider,
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
    expect(result.documentReviewPending).toBe(true);
    expect(result.message).toContain('Current draft event details to confirm:');
    expect(result.message).toContain('Venue: Riverside Hall');
    expect(result.message).toContain('Start: 2027-10-12 at 09:00 (Europe/Lisbon)');
    expect(result.message).toContain('End: 2027-10-12 at 18:00 (Europe/Lisbon)');
    expect(result.message).toContain('Organizer: Morgan Reed');
    expect(result.message).toContain('Organizer email: morgan@example.test');
    expect(result.event).toMatchObject({
      startAt: '2027-10-12T08:00:00.000Z',
      endAt: '2027-10-12T17:00:00.000Z',
    });
    expect(extractEventInformation).toHaveBeenCalledWith(
      expect.stringContaining('Organización: Morgan Reed'),
      'request-file',
      expect.arrayContaining(['startDate', 'startTime', 'organizerEmail']),
      undefined,
    );
    expect(transaction.conversation.update.mock.calls[0]?.[0]).toMatchObject({
      data: { draft: { documentReviewPending: true } },
    });
    extract.mockResolvedValueOnce({ text: 'x'.repeat(60_001), metadata: { characters: 60_001 } });
    await expect(service.analyze(actor, { clientId, sessionId }, file, 'request-large'))
      .resolves.toMatchObject({ documentReviewPending: true });
    expect(extractEventInformation).toHaveBeenCalledWith(
      expect.stringContaining('Middle sections are in the attached original file'),
      'request-large',
      [],
      expect.objectContaining({ filename: 'event-plan.txt', mimeType: 'text/plain' }),
    );
    expect(storage.upload).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('confirms document details then offers the appropriate next step (complete: %s)', async (complete) => {
    const draft = {
      event: {
        name: 'Leadership Forum', category: 'CONFERENCE', description: 'A leadership forum.',
        venue: 'Riverside Hall', startAt: complete ? '2027-10-12T08:00:00.000Z' : undefined,
        endAt: '2027-10-12T18:00:00.000Z', timezone: 'Europe/Lisbon',
        organizerName: 'Morgan Reed', organizerEmail: 'morgan@example.test',
      },
      facts: [], schedule: [], guests: [], suggestedName: 'Leadership Forum',
      nameWasProvided: true, documentReviewPending: true,
      documentReviewBaseline: { event: {}, facts: [], schedule: [], guests: [] },
      pendingDocumentNames: ['different-layout.pdf'],
    };
    const transaction = {
      conversation: { update: vi.fn().mockResolvedValue({ id: sessionId }) },
      conversationMessage: { create: vi.fn().mockImplementation(({ data }: { data: { role: string } }) =>
        Promise.resolve({ id: data.role, ...data, createdAt: new Date() })) },
    };
    const extractEventInformation = vi.fn();
    const service = new EventSetupAnalysisService(
      {
        client: { findUnique: vi.fn().mockResolvedValue({ name: 'Northstar Events' }) },
        conversation: { findFirst: vi.fn().mockResolvedValue({ id: sessionId, draft }) },
        $transaction: vi.fn((work: (value: typeof transaction) => unknown) => work(transaction)),
      } as unknown as PrismaService,
      new AuthorizationService(),
      {} as FileValidationService,
      {} as DocumentTextExtractorService,
      { extractEventInformation } as unknown as AiProvider,
      new EventCompletenessService(),
      {} as FileStorage,
    );

    const result = await service.analyze(
      actor, { clientId, sessionId, text: 'Confirm details' }, undefined, 'request-confirm',
    );

    expect(extractEventInformation).not.toHaveBeenCalled();
    expect(result.documentReviewPending).toBe(false);
    expect(result.event).toMatchObject({ name: 'Leadership Forum', venue: 'Riverside Hall' });
    expect(result.completeness.ready).toBe(complete);
    if (complete) {
      expect(result.message).toContain('Please review the event name, type, purpose, dates, location, and organizer');
      expect(result.message).toContain('Tell me anything to change');
    } else {
      expect(result.message).toContain('check the known event dates and times');
    }
    expect(transaction.conversation.update.mock.calls[0]?.[0]).toMatchObject({
      data: { draft: { documentReviewPending: false } },
    });
  });

  it('sets aside document-derived fields when the creator rejects them', async () => {
    const draft = {
      event: { name: 'Wrong name', venue: 'Wrong venue' },
      facts: [], schedule: [], guests: [], suggestedName: 'Wrong name',
      nameWasProvided: true, documentReviewPending: true,
      documentReviewBaseline: { event: { name: 'Correct name' }, facts: [], schedule: [], guests: [] },
      pendingDocumentNames: ['notes.txt'],
    };
    const transaction = {
      conversation: { update: vi.fn().mockResolvedValue({ id: sessionId }) },
      conversationMessage: { create: vi.fn().mockImplementation(({ data }: { data: { role: string } }) =>
        Promise.resolve({ id: data.role, ...data, createdAt: new Date() })) },
    };
    const service = new EventSetupAnalysisService(
      {
        client: { findUnique: vi.fn().mockResolvedValue({ name: 'Northstar Events' }) },
        conversation: { findFirst: vi.fn().mockResolvedValue({ id: sessionId, draft }) },
        $transaction: vi.fn((work: (value: typeof transaction) => unknown) => work(transaction)),
      } as unknown as PrismaService,
      new AuthorizationService(), {} as FileValidationService,
      {} as DocumentTextExtractorService, {} as AiProvider,
      { evaluate: vi.fn().mockReturnValue({ score: 25, ready: false, missing: ['location'], warnings: [], recommendations: [] }) } as unknown as EventCompletenessService,
      {} as FileStorage,
    );

    const result = await service.analyze(actor, { clientId, sessionId, text: 'Reject' }, undefined, 'request-reject');

    expect(result.event).toEqual({ name: 'Correct name' });
    expect(result.suggestedName).toBe('Correct name');
    expect(result.documentReviewPending).toBe(false);
  });
});
