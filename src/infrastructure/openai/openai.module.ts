import { Global, Module } from '@nestjs/common';
import { AiProvider } from './ai.provider';
import { OpenAiProvider } from './openai.provider';

@Global()
@Module({ providers: [{ provide: AiProvider, useClass: OpenAiProvider }], exports: [AiProvider] })
export class OpenAiModule {}
