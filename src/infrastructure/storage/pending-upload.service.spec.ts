import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../common/config/environment';
import type { AuthenticatedActor } from '../../common/types/request.types';
import type { FileStorage } from './file-storage';
import { PendingUploadService } from './pending-upload.service';

describe('PendingUploadService', () => {
  const actor = { userId: 'creator-a' } as AuthenticatedActor;
  const content = Buffer.from('%PDF-event');
  const storage = {
    createSignedUploadUrl: vi.fn().mockResolvedValue('https://storage.example.test/upload'),
    download: vi.fn().mockResolvedValue(content),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as FileStorage;
  const config = {
    get: vi.fn().mockReturnValue('a-secret-at-least-thirty-two-characters-long'),
  } as unknown as ConfigService<Environment, true>;
  const service = new PendingUploadService(config, storage);

  it('issues a scoped ticket and reconstructs the uploaded file after verifying its size', async () => {
    const issued = await service.issue(actor, 'SETUP', 'client-a:session-a', {
      name: 'brief.pdf', mimeType: 'application/pdf', size: content.length,
    });
    expect(issued.uploadUrl).toBe('https://storage.example.test/upload');
    const uploaded = await service.consume(actor, 'SETUP', 'client-a:session-a', issued.ticket);
    expect(uploaded.file).toMatchObject({
      originalname: 'brief.pdf', mimetype: 'application/pdf', size: content.length,
      buffer: content,
    });
    expect(uploaded.key).toContain('pending/creator-a/setup/');
  });

  it('rejects a ticket used by another actor or for another event', async () => {
    const issued = await service.issue(actor, 'DOCUMENT', 'event-a', {
      name: 'brief.pdf', mimeType: 'application/pdf', size: content.length,
    });
    await expect(service.consume(actor, 'DOCUMENT', 'event-b', issued.ticket))
      .rejects.toMatchObject({ code: 'INVALID_UPLOAD_TICKET' });
    await expect(service.consume({ userId: 'creator-b' } as AuthenticatedActor,
      'DOCUMENT', 'event-a', issued.ticket))
      .rejects.toMatchObject({ code: 'INVALID_UPLOAD_TICKET' });
    await expect(service.consume(actor, 'DOCUMENT', 'event-a', `${issued.ticket}x`))
      .rejects.toMatchObject({ code: 'INVALID_UPLOAD_TICKET' });
  });
});
