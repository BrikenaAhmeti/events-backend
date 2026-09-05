import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ApplicationError } from '../../../common/errors/application.error';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { AiProvider } from '../../../infrastructure/openai/ai.provider';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { DocumentTextExtractorService } from '../../documents/application/document-text-extractor.service';
import { FileValidationService } from '../../documents/application/file-validation.service';
import {
  eventFactInputSchema,
  scheduleItemSchema,
  updateEventSchema,
} from '../../events/application/event.contracts';
import { EventCompletenessService } from '../../events/domain/event-completeness.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';

const setupSchema = z.object({
  clientId: z.uuid(),
  text: z.string().trim().max(80_000).optional(),
});

const categoryLabels: Record<string, string> = {
  CORPORATE_INCENTIVE: 'Incentive Experience',
  CONFERENCE: 'Conference',
  CORPORATE_RETREAT: 'Leadership Retreat',
  WEDDING: 'Wedding Celebration',
  SPORTS_TRAVEL: 'Sports Journey',
  GROUP_TOUR: 'Group Journey',
  MEETING: 'Meeting',
  OTHER: 'Special Event',
};

@Injectable()
export class EventSetupAnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly validation: FileValidationService,
    private readonly extractor: DocumentTextExtractorService,
    private readonly ai: AiProvider,
    private readonly completeness: EventCompletenessService,
  ) {}

  async analyze(
    actor: AuthenticatedActor,
    body: unknown,
    file: Express.Multer.File | undefined,
    requestId: string,
  ) {
    const input = setupSchema.parse(body);
    this.authorization.assert(actor, input.clientId, Permission.EVENT_CREATE);
    const client = await this.prisma.client.findUnique({
      where: { id: input.clientId },
      select: { name: true },
    });
    if (!client) throw new ApplicationError(404, 'CLIENT_NOT_FOUND', 'Client not found.');
    let fileText = '';
    if (file) {
      this.validation.validate(file);
      const extension = file.originalname.toLowerCase().split('.').at(-1) ?? '';
      fileText = (await this.extractor.extract(extension, file.buffer)).text;
    }
    const source = [input.text, fileText].filter(Boolean).join('\n\n').trim();
    if (source.length < 10) {
      throw new ApplicationError(
        400,
        'EVENT_SOURCE_REQUIRED',
        'Describe the event or attach an event file to continue.',
      );
    }
    const extracted = await this.ai.extractEventInformation(source, requestId);
    const parsed = updateEventSchema.safeParse(extracted.event ?? {});
    const event = parsed.success ? parsed.data : {};
    const facts = extracted.facts.flatMap((fact) => {
      const result = eventFactInputSchema.safeParse(fact);
      return result.success ? [result.data] : [];
    });
    const schedule = extracted.schedule.flatMap((item) => {
      const result = scheduleItemSchema.safeParse(item);
      return result.success ? [result.data] : [];
    });
    const suggestedName = event.name ?? this.suggestName(event, client.name);
    const projected = {
      name: suggestedName,
      category: event.category ?? 'OTHER',
      description: event.description ?? null,
      destination: event.destination ?? null,
      venue: event.venue ?? null,
      venueAddress: event.venueAddress ?? null,
      venueDetails: event.venueDetails ?? null,
      restroomInformation: event.restroomInformation ?? null,
      accessibilityInformation: event.accessibilityInformation ?? null,
      startAt: event.startAt ? new Date(event.startAt) : null,
      endAt: event.endAt ? new Date(event.endAt) : null,
      timezone: event.timezone ?? null,
      organizerName: event.organizerName ?? null,
      organizerEmail: event.organizerEmail ?? null,
    };
    return {
      event: { ...event, name: event.name ?? undefined },
      suggestedName,
      nameWasProvided: Boolean(event.name),
      completeness: this.completeness.evaluate(projected),
      facts,
      schedule,
      extractedFacts: facts.length,
      extractedScheduleItems: schedule.length,
      file: file ? { name: file.originalname, size: file.size } : null,
    };
  }

  private suggestName(event: Record<string, unknown>, clientName: string): string {
    const category =
      typeof event.category === 'string'
        ? (categoryLabels[event.category] ?? 'Special Event')
        : 'Special Event';
    const place =
      typeof event.destination === 'string'
        ? event.destination.split(',')[0]
        : typeof event.venue === 'string'
          ? event.venue
          : clientName;
    const year =
      typeof event.startAt === 'string' && !Number.isNaN(new Date(event.startAt).getTime())
        ? ` ${new Date(event.startAt).getUTCFullYear()}`
        : '';
    return `${place} ${category}${year}`.slice(0, 160);
  }
}
