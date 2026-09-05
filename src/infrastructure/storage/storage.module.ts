import { Global, Module } from '@nestjs/common';
import { FileStorage } from './file-storage';
import { R2FileStorage } from './r2-file-storage';

@Global()
@Module({ providers: [{ provide: FileStorage, useClass: R2FileStorage }], exports: [FileStorage] })
export class StorageModule {}
