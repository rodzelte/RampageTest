import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertBrowserBundleSafe } from './lib/bundle-security';

async function readBuild(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  const contents = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(folder, entry.name);
      if (entry.isDirectory()) return readBuild(path);
      return /\.(js|html|css|map)$/.test(entry.name)
        ? [await readFile(path, 'utf8')]
        : [];
    }),
  );
  return contents.flat();
}
try {
  const files = await readBuild(resolve('dist'));
  if (files.length === 0)
    throw new Error('Run pnpm build before the bundle check.');
  assertBrowserBundleSafe(files, process.env);
  console.log(
    `PASS: ${files.length} browser build files contain no private environment values or service keys.`,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Browser build check failed.',
  );
  process.exitCode = 1;
}
