import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type Session, type User } from '@supabase/supabase-js';
import type { Environment } from '../../../common/config/environment';
import { ApplicationError } from '../../../common/errors/application.error';

export type AuthSession = Pick<Session, 'access_token' | 'refresh_token' | 'expires_in'>;

@Injectable()
export class SupabaseAuthProvider {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  async login(email: string, password: string): Promise<AuthSession> {
    const { data, error } = await this.authClient().auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      throw new ApplicationError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    return data.session;
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    const { data, error } = await this.authClient().auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (error || !data.session) {
      throw new ApplicationError(401, 'SESSION_EXPIRED', 'Your session has expired.');
    }
    return data.session;
  }

  async verify(accessToken: string): Promise<{ id: string }> {
    const { data, error } = await this.authClient().auth.getClaims(accessToken);
    const subject = data?.claims.sub;
    if (error || typeof subject !== 'string' || !subject) {
      throw new ApplicationError(401, 'UNAUTHENTICATED', 'Authentication is required.');
    }
    return { id: subject };
  }

  async createPasswordResetToken(email: string, redirectTo: string): Promise<string> {
    const { data, error } = await this.adminClient().auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo },
    });
    if (error || !data.properties.hashed_token) {
      throw new ApplicationError(
        502,
        'PASSWORD_RESET_FAILED',
        'Password reset instructions could not be created.',
      );
    }
    return data.properties.hashed_token;
  }

  async changePassword(email: string, currentPassword: string, newPassword: string): Promise<void> {
    const client = this.authClient();
    const { data, error } = await client.auth.signInWithPassword({
      email,
      password: currentPassword,
    });
    if (error || !data.session) {
      throw new ApplicationError(
        401,
        'CURRENT_PASSWORD_INVALID',
        'The current password is incorrect.',
      );
    }
    const { error: updateError } = await client.auth.updateUser({ password: newPassword });
    if (updateError) {
      throw new ApplicationError(
        400,
        'PASSWORD_UPDATE_FAILED',
        'The password could not be updated.',
      );
    }
  }

  async inviteUser(
    email: string,
    redirectTo: string,
    metadata: Record<string, string>,
  ): Promise<string> {
    const { data, error } = await this.adminClient().auth.admin.generateLink({
      type: 'invite',
      email,
      options: { redirectTo, data: metadata },
    });
    if (error) {
      throw new ApplicationError(
        502,
        'AUTH_INVITATION_FAILED',
        'Staff invitation could not be created.',
      );
    }
    return data.properties.hashed_token;
  }

  async completeOtp(
    tokenHash: string,
    password: string,
    type: 'invite' | 'recovery',
  ): Promise<{ session: AuthSession; user: User }> {
    const client = this.authClient();
    const { data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error || !data.session || !data.user)
      throw new ApplicationError(
        401,
        'ACTIVATION_INVALID',
        'This activation link is invalid or expired.',
      );
    const { error: updateError } = await client.auth.updateUser({ password });
    if (updateError)
      throw new ApplicationError(
        400,
        'PASSWORD_UPDATE_FAILED',
        'The password could not be updated.',
      );
    return { session: data.session, user: data.user };
  }

  async provisionUser(email: string, metadata: Record<string, string>): Promise<string> {
    const { data, error } = await this.adminClient().auth.admin.createUser({
      email,
      email_confirm: false,
      user_metadata: metadata,
    });
    if (error || !data.user) {
      throw new ApplicationError(
        502,
        'AUTH_PROVISIONING_FAILED',
        'The account could not be provisioned.',
      );
    }
    return data.user.id;
  }

  private authClient() {
    const url = this.config.get('SUPABASE_URL', { infer: true });
    const key = this.config.get('SUPABASE_SECRET_KEY', { infer: true });
    if (!url || !key) throw this.unavailable();
    return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private adminClient() {
    const url = this.config.get('SUPABASE_URL', { infer: true });
    const key = this.config.get('SUPABASE_SECRET_KEY', { infer: true });
    if (!url || !key) throw this.unavailable();
    return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private unavailable(): ApplicationError {
    return new ApplicationError(
      503,
      'AUTH_PROVIDER_UNAVAILABLE',
      'Authentication is not configured.',
    );
  }
}
