import { Global, Module } from '@nestjs/common';
import { AuthService } from './application/auth.service';
import { SupabaseAuthProvider } from './infrastructure/supabase-auth.provider';
import { AuthController } from './presentation/auth.controller';
import { PlatformAuthGuard } from './presentation/platform-auth.guard';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, SupabaseAuthProvider, PlatformAuthGuard],
  exports: [SupabaseAuthProvider, PlatformAuthGuard],
})
export class AuthModule {}
