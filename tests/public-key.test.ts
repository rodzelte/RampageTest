import { describe, expect, it } from 'vitest';
import { publicSupabaseKeySchema } from '../src/shared/public-key';

function jwt(role: string) {
  return `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
}

describe('frontend public-key configuration', () => {
  it.each(['sb_publishable_test123', jwt('anon')])(
    'accepts supported public key formats',
    (key) => {
      expect(publicSupabaseKeySchema.safeParse(key).success).toBe(true);
    },
  );
  it.each([
    'sb_secret_test123',
    jwt('service_role'),
    jwt('authenticated'),
    '',
    'malformed.key.value',
  ])('rejects privileged or malformed keys', (key) => {
    expect(publicSupabaseKeySchema.safeParse(key).success).toBe(false);
  });
});
