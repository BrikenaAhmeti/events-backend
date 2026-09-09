import { Global, Module } from '@nestjs/common';
import { FileStorage } from './file-storage';
import { SupabaseFileStorage } from './supabase-file-storage';

@Global()
@Module({
  providers: [{ provide: FileStorage, useClass: SupabaseFileStorage }],
  exports: [FileStorage],
})
export class StorageModule {}
