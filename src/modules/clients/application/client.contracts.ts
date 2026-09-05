import { z } from 'zod';

export const createClientSchema = z.object({
  name: z.string().trim().min(2).max(120),
  contactEmail: z.email().optional(),
  admin: z
    .object({
      email: z.email().transform((value) => value.toLowerCase()),
      firstName: z.string().trim().min(1).max(80),
      lastName: z.string().trim().min(1).max(80),
    })
    .optional(),
});

export const updateClientSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  contactEmail: z.email().nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
