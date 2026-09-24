import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Environment } from '../../common/config/environment';
import { ApplicationError } from '../../common/errors/application.error';
import { FileStorage, type StoredFile } from './file-storage';

@Injectable()
export class SupabaseFileStorage extends FileStorage {
  private readonly logger = new Logger(SupabaseFileStorage.name);
  private supabase?: SupabaseClient;

  constructor(private readonly config: ConfigService<Environment, true>) {
    super();
  }

  async upload(objectKey: string, content: Buffer, mimeType: string): Promise<StoredFile> {
    const bucket = this.bucket();
    const { error } = await this.client().storage.from(bucket).upload(objectKey, content, {
      contentType: mimeType,
      upsert: false,
    });
    if (error) {
      this.logger.error({
        operation: 'upload',
        bucket,
        providerStatus: error.statusCode,
        providerError: error.name,
        providerMessage: error.message,
      }, 'Supabase Storage upload failed');
      throw new ApplicationError(502, 'FILE_UPLOAD_FAILED', 'The file could not be uploaded.');
    }
    return { objectKey, bucket };
  }

  async download(objectKey: string): Promise<Buffer> {
    const { data, error } = await this.client().storage.from(this.bucket()).download(objectKey);
    if (error || !data) {
      throw new ApplicationError(404, 'FILE_NOT_FOUND', 'The file could not be found.');
    }
    return Buffer.from(await data.arrayBuffer());
  }

  async delete(objectKey: string): Promise<void> {
    const { error } = await this.client().storage.from(this.bucket()).remove([objectKey]);
    if (error) {
      throw new ApplicationError(502, 'FILE_DELETE_FAILED', 'The file could not be deleted.');
    }
  }

  async exists(objectKey: string): Promise<boolean> {
    const { data, error } = await this.client().storage.from(this.bucket()).exists(objectKey);
    if (error) {
      throw new ApplicationError(502, 'FILE_LOOKUP_FAILED', 'The file could not be checked.');
    }
    return data;
  }

  async createSignedDownloadUrl(objectKey: string, expiresInSeconds: number): Promise<string> {
    const { data, error } = await this.client()
      .storage.from(this.bucket())
      .createSignedUrl(objectKey, Math.min(expiresInSeconds, 900), {
        download: true,
      });
    if (error || !data?.signedUrl) {
      throw new ApplicationError(
        502,
        'SIGNED_URL_FAILED',
        'A secure download link could not be created.',
      );
    }
    return data.signedUrl;
  }

  private client(): SupabaseClient {
    if (this.supabase) return this.supabase;
    const url = this.config.get('SUPABASE_URL', { infer: true });
    const secretKey = this.config.get('SUPABASE_SECRET_KEY', { infer: true });
    if (!url || !secretKey) {
      throw new ApplicationError(503, 'STORAGE_UNAVAILABLE', 'File storage is not configured.');
    }
    this.supabase = createClient(url, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return this.supabase;
  }

  private bucket(): string {
    const bucket = this.config.get('SUPABASE_STORAGE_BUCKET', { infer: true });
    if (!bucket) {
      throw new ApplicationError(503, 'STORAGE_UNAVAILABLE', 'File storage is not configured.');
    }
    return bucket;
  }
}
