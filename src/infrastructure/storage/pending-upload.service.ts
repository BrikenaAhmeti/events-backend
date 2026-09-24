import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from '../../common/config/upload-limits';
import type { Environment } from '../../common/config/environment';
import { ApplicationError } from '../../common/errors/application.error';
import type { AuthenticatedActor } from '../../common/types/request.types';
import { FileStorage } from './file-storage';

export const uploadMetadataSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(150),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});

type UploadPurpose = 'SETUP' | 'DOCUMENT' | 'GUEST_IMPORT';
const ticketSchema = uploadMetadataSchema.extend({
  key: z.string().min(1),
  purpose: z.enum(['SETUP', 'DOCUMENT', 'GUEST_IMPORT']),
  context: z.string().min(1),
  userId: z.string().min(1),
  expiresAt: z.number().int(),
});

@Injectable()
export class PendingUploadService {
  private readonly logger = new Logger(PendingUploadService.name);

  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly storage: FileStorage,
  ) {}

  async issue(actor: AuthenticatedActor, purpose: UploadPurpose, context: string, body: unknown) {
    const metadata = uploadMetadataSchema.parse(body);
    const extension = metadata.name.toLowerCase().split('.').at(-1) ?? '';
    const allowed = purpose === 'GUEST_IMPORT' ? ['csv', 'xlsx'] : ['pdf', 'docx', 'txt', 'csv', 'xlsx'];
    if (!allowed.includes(extension))
      throw new ApplicationError(400, 'UNSUPPORTED_FILE_TYPE', `Supported formats are ${allowed.join(', ').toUpperCase()}.`);
    const key = `pending/${actor.userId}/${purpose.toLowerCase()}/${randomUUID()}`;
    const uploadUrl = await this.storage.createSignedUploadUrl(key);
    const payload = ticketSchema.parse({
      ...metadata, key, purpose, context, userId: actor.userId,
      expiresAt: Date.now() + 30 * 60_000,
    });
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = this.sign(encoded);
    return { uploadUrl, ticket: `${encoded}.${signature}` };
  }

  async consume(actor: AuthenticatedActor, purpose: UploadPurpose, context: string, ticket: string) {
    const [encoded, signature, extra] = ticket.split('.');
    if (!encoded || !signature || extra || !this.validSignature(encoded, signature))
      throw new ApplicationError(400, 'INVALID_UPLOAD_TICKET', 'The upload link is invalid or expired.');
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
    catch { parsed = null; }
    const result = ticketSchema.safeParse(parsed);
    if (!result.success || result.data.userId !== actor.userId || result.data.purpose !== purpose ||
      result.data.context !== context || result.data.expiresAt < Date.now())
      throw new ApplicationError(400, 'INVALID_UPLOAD_TICKET', 'The upload link is invalid or expired.');
    const content = await this.storage.download(result.data.key);
    if (content.length !== result.data.size || content.length > MAX_UPLOAD_BYTES)
      throw new ApplicationError(400, 'FILE_TOO_LARGE', `Files must be ${MAX_UPLOAD_LABEL} or smaller.`);
    const file: Express.Multer.File = {
      fieldname: 'file', originalname: result.data.name, encoding: '7bit',
      mimetype: result.data.mimeType, size: content.length, buffer: content,
      destination: '', filename: '', path: '', stream: null as never,
    };
    return { file, key: result.data.key };
  }

  async remove(key: string): Promise<void> {
    try { await this.storage.delete(key); }
    catch { this.logger.warn('A temporary upload could not be removed.'); }
  }

  private sign(value: string): string {
    return createHmac('sha256', this.config.get('COOKIE_SECRET', { infer: true }))
      .update(value).digest('base64url');
  }

  private validSignature(encoded: string, signature: string): boolean {
    const supplied = Buffer.from(signature);
    const expected = Buffer.from(this.sign(encoded));
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
}
