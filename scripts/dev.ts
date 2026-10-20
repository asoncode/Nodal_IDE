import { createServer } from 'vite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/persistence/src/index.js';
import { NodalService } from '../packages/runtime/src/service.js';
import { startServer } from '../packages/runtime/src/server.js';
const dataDir = process.env.NODAL_DATA_DIR ?? join(homedir(), '.local', 'share', 'nodal');
const store = new Store(join(dataDir, 'nodal.sqlite'));
const runtime = await startServer(new NodalService(store, dataDir));
const vite = await createServer({ configFile: 'apps/desktop/vite.config.ts', server: { host: '127.0.0.1', port: 5173, strictPort: true } });
await vite.listen();
const port = new URL(runtime.url).port;
console.log(`\nNodal is ready: http://127.0.0.1:5173/?launch=${Date.now()}#token=${runtime.token}&port=${port}\nKeep this local launch URL private. Data: ${dataDir}\n`);
let closing = false;
async function shutdown() { if (closing) return; closing = true; await vite.close(); await runtime.close(); store.close(); process.exit(0); }
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
