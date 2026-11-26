import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
try {
  const config = JSON.parse(readFileSync(new URL('wrangler.jsonc', root), 'utf8'));
  const origin = new URL(config.vars.PUBLIC_ORIGIN);
  const id = config.kv_namespaces.find(binding => binding.binding === 'OAUTH_KV')?.id;
  if (origin.protocol !== 'https:' || origin.origin !== config.vars.PUBLIC_ORIGIN ||
      origin.hostname === 'your-worker.your-subdomain.workers.dev' ||
      !/^[a-f0-9]{32}$/i.test(id ?? '') || id === '00000000000000000000000000000000') {
    throw new Error('Incomplete deployment settings');
  }
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', root)),
    'deploy', '--config', 'wrangler.jsonc',
  ], {cwd:fileURLToPath(root), stdio:'inherit'});
  process.exitCode = result.status ?? 1;
} catch {
  console.error('Copy wrangler.example.jsonc to wrangler.jsonc and set your HTTPS origin and OAUTH_KV ID.');
  process.exitCode = 1;
}
