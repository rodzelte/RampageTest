import { describe, expect, it } from 'vitest';
import { assertBrowserBundleSafe } from '../scripts/lib/bundle-security';

describe('production browser bundle security', () => {
  it('accepts a public anon key and normal application code', () => {
    expect(() =>
      assertBrowserBundleSafe(
        ['sb_publishable_publictest', 'const title="Rampage";'],
        {},
      ),
    ).not.toThrow();
  });
  it('rejects exact private environment values without printing them', () => {
    expect(() =>
      assertBrowserBundleSafe(['server-value-only-123'], {
        SUPABASE_SERVICE_ROLE_KEY: 'server-value-only-123',
      }),
    ).toThrow('private environment');
  });
  it('rejects service/secret keys without requiring a configured environment', () => {
    expect(() =>
      assertBrowserBundleSafe(['sb_secret_accidental123'], {}),
    ).toThrow();
    const payload = Buffer.from(
      JSON.stringify({ role: 'service_role' }),
    ).toString('base64url');
    expect(() =>
      assertBrowserBundleSafe(
        [`eyJhbGciOiJIUzI1NiJ9.${payload}.signature`],
        {},
      ),
    ).toThrow('privileged');
  });
});
