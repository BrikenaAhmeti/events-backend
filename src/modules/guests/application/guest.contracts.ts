import { z } from 'zod';

export const guestSchema = z.object({
  fullName: z.string().trim().min(2).max(200),
  email: z.email().transform((value) => value.trim().toLowerCase()),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  company: z.string().trim().max(200).optional(),
  jobTitle: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(80).optional(),
  guestGroup: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(5_000).optional(),
  dietaryInformation: z.string().trim().max(2_000).optional(),
  accessibilityInformation: z.string().trim().max(2_000).optional(),
  accommodation: z.string().trim().max(2_000).optional(),
  travelInformation: z.string().trim().max(2_000).optional(),
  metadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});

export const importGuestsSchema = z.object({ rows: z.array(guestSchema).min(1).max(5_000) });

export const chatGuestSchema = guestSchema.pick({
  fullName: true,
  email: true,
  company: true,
  guestGroup: true,
});

export function validChatGuests(candidates: Array<unknown> = []) {
  const guests = new Map<string, z.infer<typeof chatGuestSchema>>();
  const missingEmails: string[] = [];
  for (const candidate of candidates) {
    const result = chatGuestSchema.safeParse(candidate);
    if (result.success) guests.set(result.data.email, result.data);
    else if (candidate && typeof candidate === 'object' && 'fullName' in candidate &&
      typeof candidate.fullName === 'string' && candidate.fullName.trim())
      missingEmails.push(candidate.fullName.trim());
  }
  return { guests: [...guests.values()], missingEmails };
}

export const updateGuestSchema = guestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0);

export type GuestInput = z.infer<typeof guestSchema>;
export type UpdateGuestInput = z.infer<typeof updateGuestSchema>;
