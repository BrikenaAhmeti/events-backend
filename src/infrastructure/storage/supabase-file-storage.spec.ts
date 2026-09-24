import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import type { Environment } from '../../common/config/environment';
import { SupabaseFileStorage } from './supabase-file-storage';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

const config = (overrides: Partial<Environment> = {}) => {
  const values = {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SECRET_KEY: 'secret-key',
    SUPABASE_STORAGE_BUCKET: 'events-files',
    ...overrides,
  };
  return {
    get: vi.fn((key: keyof Environment) => values[key] ?? ''),
  } as unknown as ConfigService<Environment, true>;
};

describe('SupabaseFileStorage', () => {
  const files = {
    upload: vi.fn(),
    download: vi.fn(),
    remove: vi.fn(),
    exists: vi.fn(),
    createSignedUrl: vi.fn(),
    createSignedUploadUrl: vi.fn(),
  };
  const from = vi.fn(() => files);
  const createClientMock = vi.mocked(createClient);

  beforeEach(() => {
    vi.clearAllMocks();
    createClientMock.mockReturnValue({ storage: { from } } as never);
  });

  it('uploads into the configured private bucket with the original content type', async () => {
    files.upload.mockResolvedValue({
      data: { path: 'document.pdf' },
      error: null,
    });
    const storage = new SupabaseFileStorage(config());
    const content = Buffer.from('%PDF-demo');

    await expect(
      storage.upload('documents/document.pdf', content, 'application/pdf'),
    ).resolves.toEqual({
      objectKey: 'documents/document.pdf',
      bucket: 'events-files',
    });
    expect(createClientMock).toHaveBeenCalledWith('https://project.supabase.co', 'secret-key', {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    expect(files.upload).toHaveBeenCalledWith('documents/document.pdf', content, {
      contentType: 'application/pdf',
      upsert: false,
    });
  });

  it('records the provider reason when an upload fails without exposing it to the caller', async () => {
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    files.upload.mockResolvedValue({
      data: null,
      error: { statusCode: '404', name: 'StorageApiError', message: 'Bucket not found' },
    });
    const storage = new SupabaseFileStorage(config());

    await expect(storage.upload('documents/document.pdf', Buffer.from('file'), 'application/pdf'))
      .rejects.toMatchObject({ statusCode: 502, code: 'FILE_UPLOAD_FAILED' });
    expect(logError).toHaveBeenCalledWith({
      operation: 'upload',
      bucket: 'events-files',
      providerStatus: '404',
      providerError: 'StorageApiError',
      providerMessage: 'Bucket not found',
    }, 'Supabase Storage upload failed');
  });

  it('downloads private file content and deletes the exact object key', async () => {
    files.download.mockResolvedValue({
      data: new Blob(['file-content']),
      error: null,
    });
    files.remove.mockResolvedValue({ data: [], error: null });
    const storage = new SupabaseFileStorage(config());

    await expect(storage.download('documents/document.txt')).resolves.toEqual(
      Buffer.from('file-content'),
    );
    await expect(storage.delete('documents/document.txt')).resolves.toBeUndefined();
    expect(files.remove).toHaveBeenCalledWith(['documents/document.txt']);
  });

  it('checks existence and limits signed download URLs to fifteen minutes', async () => {
    files.exists.mockResolvedValue({ data: true, error: null });
    files.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://project.supabase.co/signed/document' },
      error: null,
    });
    const storage = new SupabaseFileStorage(config());

    await expect(storage.exists('documents/document.pdf')).resolves.toBe(true);
    await expect(storage.createSignedDownloadUrl('documents/document.pdf', 3_600)).resolves.toBe(
      'https://project.supabase.co/signed/document',
    );
    expect(files.createSignedUrl).toHaveBeenCalledWith('documents/document.pdf', 900, {
      download: true,
    });
  });

  it('creates a signed upload URL for the private bucket', async () => {
    files.createSignedUploadUrl.mockResolvedValue({
      data: { signedUrl: 'https://project.supabase.co/signed/upload' }, error: null,
    });
    const storage = new SupabaseFileStorage(config());
    await expect(storage.createSignedUploadUrl('pending/brief.pdf'))
      .resolves.toBe('https://project.supabase.co/signed/upload');
    expect(files.createSignedUploadUrl).toHaveBeenCalledWith('pending/brief.pdf');
  });

  it('fails closed when the backend-only Supabase secret is missing', async () => {
    const storage = new SupabaseFileStorage(config({ SUPABASE_SECRET_KEY: '' }));

    await expect(
      storage.upload('document.pdf', Buffer.from('file'), 'application/pdf'),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'STORAGE_UNAVAILABLE',
    });
  });
});
