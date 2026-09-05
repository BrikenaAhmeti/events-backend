import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Environment } from '../../common/config/environment';
import { ApplicationError } from '../../common/errors/application.error';
import { FileStorage, type StoredFile } from './file-storage';

@Injectable()
export class R2FileStorage extends FileStorage {
  constructor(private readonly config: ConfigService<Environment, true>) {
    super();
  }

  async upload(objectKey: string, content: Buffer, mimeType: string): Promise<StoredFile> {
    const bucket = this.bucket();
    await this.client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: content,
        ContentType: mimeType,
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
    return { objectKey, bucket };
  }

  async download(objectKey: string): Promise<Buffer> {
    const result = await this.client().send(
      new GetObjectCommand({ Bucket: this.bucket(), Key: objectKey }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
    if (!result.Body)
      throw new ApplicationError(404, 'FILE_NOT_FOUND', 'The file could not be found.');
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async delete(objectKey: string): Promise<void> {
    await this.client().send(new DeleteObjectCommand({ Bucket: this.bucket(), Key: objectKey }), {
      abortSignal: AbortSignal.timeout(30_000),
    });
  }

  async exists(objectKey: string): Promise<boolean> {
    try {
      await this.client().send(new HeadObjectCommand({ Bucket: this.bucket(), Key: objectKey }), {
        abortSignal: AbortSignal.timeout(15_000),
      });
      return true;
    } catch {
      return false;
    }
  }

  createSignedDownloadUrl(objectKey: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client(),
      new GetObjectCommand({ Bucket: this.bucket(), Key: objectKey }),
      { expiresIn: Math.min(expiresInSeconds, 900) },
    );
  }

  private client(): S3Client {
    const endpoint = this.config.get('R2_ENDPOINT', { infer: true });
    const accessKeyId = this.config.get('R2_ACCESS_KEY_ID', { infer: true });
    const secretAccessKey = this.config.get('R2_SECRET_ACCESS_KEY', { infer: true });
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new ApplicationError(503, 'STORAGE_UNAVAILABLE', 'File storage is not configured.');
    }
    return new S3Client({
      region: 'auto',
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  private bucket(): string {
    const bucket = this.config.get('R2_BUCKET', { infer: true });
    if (!bucket)
      throw new ApplicationError(503, 'STORAGE_UNAVAILABLE', 'File storage is not configured.');
    return bucket;
  }
}
