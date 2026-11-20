import { createJiti } from 'jiti';
import { join } from 'node:path';
const jiti = createJiti(import.meta.url);
const { LocklessReadAccountStore } = await jiti.import('../../src/account-store.ts');
const { refreshAccountCredential } = await jiti.import('../../src/refresh.ts');
const [dir, url] = process.argv.slice(2);
const store = new LocklessReadAccountStore(join(dir, 'pi-accounts.json'));
const credential = (await store.readProviderAsync('anthropic')).accounts.work;
process.stdout.write('ready\n');
await new Promise((resolve) => process.stdin.once('data', resolve));
const adapter = { id: 'anthropic', oauth: { refresh: async () => {
  const response = await fetch(url, { method: 'POST' });
  if (!response.ok) throw new Error('fixture refresh failed');
  return response.json();
} } };
await refreshAccountCredential(store, adapter, 'work', credential);
process.stdout.write('done\n');
process.stdin.destroy();
