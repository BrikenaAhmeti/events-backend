import { Global, Module } from '@nestjs/common';
import { FileStorage } from './file-storage';
import { SupabaseFileStorage } from './supabase-file-storage';
import { PendingUploadService } from './pending-upload.service';

@Global()
@Module({
  providers: [{ provide: FileStorage, useClass: SupabaseFileStorage }, PendingUploadService],
  exports: [FileStorage, PendingUploadService],
})
export class StorageModule {}
