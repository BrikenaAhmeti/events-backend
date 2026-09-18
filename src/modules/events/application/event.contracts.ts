import { z } from 'zod';

export const eventCategories = [
  'CORPORATE_INCENTIVE',
  'CONFERENCE',
  'CORPORATE_RETREAT',
  'WEDDING',
  'SPORTS_TRAVEL',
  'GROUP_TOUR',
  'MEETING',
  'OTHER',
] as const;

const categoryAliases: Record<string, (typeof eventCategories)[number]> = {
  INCENTIVE: 'CORPORATE_INCENTIVE',
  INCENTIVE_TRIP: 'CORPORATE_INCENTIVE',
  MICE: 'CONFERENCE',
  CONGRESS: 'CONFERENCE',
  RETREAT: 'CORPORATE_RETREAT',
  SPORTS: 'SPORTS_TRAVEL',
  TOUR: 'GROUP_TOUR',
};

export const normalizeEventCategory = (value: string): string => {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return categoryAliases[normalized] ?? normalized;
};

const eventFields = {
  name: z.string().trim().min(2).max(160),
  category: z.string().trim().min(2).max(80).transform(normalizeEventCategory),
  description: z.string().trim().min(10).max(10_000),
  destination: z.string().trim().min(2).max(200),
  venue: z.string().trim().min(2).max(200),
  venueAddress: z.string().trim().min(3).max(500),
  venueDetails: z.string().trim().min(3).max(5_000),
  restroomInformation: z.string().trim().min(3).max(3_000),
  accessibilityInformation: z.string().trim().min(3).max(3_000),
  parkingInformation: z.string().trim().min(3).max(3_000),
  wifiInformation: z.string().trim().min(3).max(3_000),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
  timezone: z.string().trim().min(3).max(100),
  organizerName: z.string().trim().min(2).max(160),
  organizerEmail: z.email(),
};

export const eventFactInputSchema = z.object({
  key: z.string().trim().min(1).max(160),
  value: z.string().trim().min(1).max(5_000),
  confidence: z.number().min(0).max(1),
});

export const scheduleItemSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(5_000).optional(),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime().optional(),
  location: z.string().trim().max(200).optional(),
  category: z.string().trim().max(80).optional(),
});

export const createEventSchema = z.object({
  clientId: z.uuid(),
  setupSessionId: z.uuid().optional(),
  name: eventFields.name,
  category: eventFields.category,
  description: eventFields.description.optional(),
  destination: eventFields.destination.optional(),
  venue: eventFields.venue.optional(),
  venueAddress: eventFields.venueAddress.optional(),
  venueDetails: eventFields.venueDetails.optional(),
  restroomInformation: eventFields.restroomInformation.optional(),
  accessibilityInformation: eventFields.accessibilityInformation.optional(),
  parkingInformation: eventFields.parkingInformation.optional(),
  wifiInformation: eventFields.wifiInformation.optional(),
  startAt: eventFields.startAt.optional(),
  endAt: eventFields.endAt.optional(),
  timezone: eventFields.timezone.optional(),
  organizerName: eventFields.organizerName.optional(),
  organizerEmail: eventFields.organizerEmail.optional(),
  facts: z.array(eventFactInputSchema).max(200).optional(),
  schedule: z.array(scheduleItemSchema).max(200).optional(),
});

export const updateEventSchema = z.object({
  name: eventFields.name.optional(),
  category: eventFields.category.optional(),
  description: eventFields.description.nullable().optional(),
  destination: eventFields.destination.nullable().optional(),
  venue: eventFields.venue.nullable().optional(),
  venueAddress: eventFields.venueAddress.nullable().optional(),
  venueDetails: eventFields.venueDetails.nullable().optional(),
  restroomInformation: eventFields.restroomInformation.nullable().optional(),
  accessibilityInformation: eventFields.accessibilityInformation.nullable().optional(),
  parkingInformation: eventFields.parkingInformation.nullable().optional(),
  wifiInformation: eventFields.wifiInformation.nullable().optional(),
  startAt: eventFields.startAt.nullable().optional(),
  endAt: eventFields.endAt.nullable().optional(),
  timezone: eventFields.timezone.nullable().optional(),
  organizerName: eventFields.organizerName.nullable().optional(),
  organizerEmail: eventFields.organizerEmail.nullable().optional(),
  configuration: z.record(z.string(), z.unknown()).optional(),
});

export const updateEventDetailsSchema = updateEventSchema.extend({
  facts: z.array(eventFactInputSchema).max(200).optional(),
});

const lifecycleFilterSchema = z.enum(['UNSCHEDULED', 'UPCOMING', 'ONGOING', 'PAST', 'CANCELLED']);
const eventStatusFilterSchema = z.enum(['DRAFT', 'READY', 'PUBLISHED', 'CANCELLED', 'ARCHIVED']);
const splitMultiValueQuery = (value: unknown) => {
  if (value === undefined || value === '') return undefined;
  const inputs: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
  const values: string[] = [];
  for (const input of inputs) {
    if (typeof input !== 'string') return value;
    for (const part of input.split(',')) {
      const normalized = part.trim();
      if (normalized) values.push(normalized);
    }
  }
  return [...new Set(values)];
};

export const eventListQuerySchema = z
  .object({
    clientId: z.uuid().optional(),
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    lifecycle: z.preprocess(
      splitMultiValueQuery,
      z.array(lifecycleFilterSchema).min(1).max(5).optional(),
    ),
    status: z.preprocess(
      splitMultiValueQuery,
      z.array(eventStatusFilterSchema).min(1).max(5).optional(),
    ),
    date: z.iso.date().optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    search: z.string().trim().max(160).optional(),
    createdByUserId: z.uuid().optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start date must be before the end date.',
    path: ['from'],
  });

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventDetailsSchema>;
export type ScheduleItemInput = z.infer<typeof scheduleItemSchema>;
export type EventListQueryInput = z.infer<typeof eventListQuerySchema>;
