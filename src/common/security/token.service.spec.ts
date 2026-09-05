import { TokenService } from './token.service';

describe('TokenService', () => {
  it('issues opaque high-entropy secrets and stores deterministic hashes', () => {
    const service = new TokenService();
    const first = service.issue();
    const second = service.issue();
    expect(first.raw).not.toBe(first.hash);
    expect(first.raw.length).toBeGreaterThanOrEqual(40);
    expect(first.hash).toBe(service.hash(first.raw));
    expect(first.raw).not.toBe(second.raw);
  });
});
