import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import type { Environment } from '../../../common/config/environment';
import { ApplicationError } from '../../../common/errors/application.error';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { FileStorage } from '../../../infrastructure/storage/file-storage';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';
import { EventMutationPolicyService } from '../../events/domain/event-mutation-policy.service';
import { FileValidationService } from './file-validation.service';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorage,
    private readonly validation: FileValidationService,
    private readonly authorization: AuthorizationService,
    private readonly config: ConfigService<Environment, true>,
    private readonly eventPolicy: EventMutationPolicyService,
  ) {}

  async list(actor: AuthenticatedActor, eventId: string) {
    const event = await this.authorize(actor, eventId, Permission.EVENT_READ);
    return this.prisma.document.findMany({
      where: { eventId: event.id, clientId: event.clientId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        originalName: true,
        mimeType: true,
        size: true,
        processingStatus: true,
        processingError: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async upload(
    actor: AuthenticatedActor,
    requestId: string,
    eventId: string,
    file: Express.Multer.File,
  ) {
    const event = await this.authorize(actor, eventId, Permission.DOCUMENT_UPLOAD);
    this.eventPolicy.assertMutable(actor, event, Permission.DOCUMENT_UPLOAD);
    const extension = this.validation.validate(file);
    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    const duplicate = await this.prisma.document.findUnique({
      where: { eventId_checksum: { eventId, checksum } },
    });
    if (duplicate)
      throw new ApplicationError(
        409,
        'DOCUMENT_ALREADY_EXISTS',
        'This exact file has already been uploaded.',
        { documentId: duplicate.id },
      );
    const objectKey = `clients/${event.clientId}/events/${eventId}/documents/${randomUUID()}.${extension}`;
    const stored = await this.storage.upload(objectKey, file.buffer, file.mimetype);
    try {
      const document = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.document.create({
          data: {
            clientId: event.clientId,
            eventId,
            uploadedByUserId: actor.userId,
            originalName: file.originalname.slice(0, 255),
            objectKey: stored.objectKey,
            bucket: stored.bucket,
            mimeType: file.mimetype,
            size: file.size,
            checksum,
            processingStatus: 'QUEUED',
          },
        });
        await transaction.auditLog.create({
          data: {
            actorUserId: actor.userId,
            clientId: event.clientId,
            eventId,
            action: 'DOCUMENT_UPLOADED',
            entityType: 'Document',
            entityId: created.id,
            requestId,
          },
        });
        await transaction.backgroundJob.upsert({
          where: { idempotencyKey: `document:${created.id}:v1` },
          create: {
            type: 'DOCUMENT_PROCESS',
            idempotencyKey: `document:${created.id}:v1`,
            clientId: event.clientId,
            eventId,
            payload: { documentId: created.id, requestId },
          },
          update: {},
        });
        return created;
      });
      return {
        id: document.id,
        originalName: document.originalName,
        processingStatus: document.processingStatus,
      };
    } catch (error) {
      await this.storage.delete(objectKey).catch(() => undefined);
      throw error;
    }
  }

  async assertUploadAccess(actor: AuthenticatedActor, eventId: string): Promise<void> {
    const event = await this.authorize(actor, eventId, Permission.DOCUMENT_UPLOAD);
    this.eventPolicy.assertMutable(actor, event, Permission.DOCUMENT_UPLOAD);
  }

  async downloadUrl(actor: AuthenticatedActor, eventId: string, documentId: string) {
    const event = await this.authorize(actor, eventId, Permission.EVENT_READ);
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, eventId, clientId: event.clientId },
    });
    if (!document) throw new ApplicationError(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
    return {
      url: await this.storage.createSignedDownloadUrl(document.objectKey, 300),
      expiresIn: 300,
    };
  }

  private async authorize(actor: AuthenticatedActor, eventId: string, permission: Permission) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        clientId: true,
        createdByUserId: true,
        status: true,
        startAt: true,
        endAt: true,
      },
    });
    if (!event) throw new ApplicationError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    this.authorization.assert(actor, event.clientId, permission);
    return event;
  }
}
