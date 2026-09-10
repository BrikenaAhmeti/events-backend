import { isSameOrigin, normalizeOrigin } from './origin';

describe('origin helpers', () => {
  it('normalizes paths and trailing slashes to the URL origin', () => {
    expect(normalizeOrigin('https://feliam.vercel.app/')).toBe('https://feliam.vercel.app');
    expect(normalizeOrigin('https://feliam.vercel.app/login')).toBe(
      'https://feliam.vercel.app',
    );
  });

  it('matches equivalent origins and rejects other or invalid origins', () => {
    expect(isSameOrigin('https://feliam.vercel.app', 'https://feliam.vercel.app/')).toBe(true);
    expect(isSameOrigin('https://attacker.example', 'https://feliam.vercel.app')).toBe(false);
    expect(isSameOrigin('not-a-url', 'https://feliam.vercel.app')).toBe(false);
    expect(isSameOrigin(undefined, 'https://feliam.vercel.app')).toBe(false);
  });
});
