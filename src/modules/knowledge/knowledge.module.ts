import { Module } from '@nestjs/common';
import { EventKnowledgeRepository } from './infrastructure/event-knowledge.repository';

@Module({ providers: [EventKnowledgeRepository], exports: [EventKnowledgeRepository] })
export class KnowledgeModule {}
