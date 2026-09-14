export function assertBrowserBundleSafe(
  contents: string[],
  env: NodeJS.ProcessEnv,
) {
  const bundle = contents.join('\n');
  for (const [name, value] of Object.entries(env)) {
    if (
      value &&
      value.length >= 8 &&
      /SERVICE_ROLE|SECRET|PASSWORD|BOT_TOKEN/.test(name) &&
      bundle.includes(value)
    ) {
      throw new Error(
        'A private environment value was found in the browser build.',
      );
    }
  }
  if (
    bundle.includes('SUPABASE_SERVICE_ROLE_KEY') ||
    /sb_secret_[A-Za-z0-9_-]{8,}/.test(bundle)
  ) {
    throw new Error(
      'Server-only configuration was found in the browser build.',
    );
  }
  for (const match of bundle.matchAll(
    /eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g,
  )) {
    try {
      const claims: unknown = JSON.parse(
        Buffer.from(match[1]!, 'base64url').toString('utf8'),
      );
      if (
        typeof claims === 'object' &&
        claims !== null &&
        'role' in claims &&
        claims.role === 'service_role'
      ) {
        throw new Error(
          'A privileged Supabase key was found in the browser build.',
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('privileged Supabase')
      )
        throw error;
    }
  }
}
