import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../persistence/src/index.js';
import { NodalService } from './service.js';
import { startServer } from './server.js';
const dataDir = process.env.NODAL_DATA_DIR ?? join(homedir(), '.local', 'share', 'nodal');
const store = new Store(join(dataDir, 'nodal.sqlite'));
const service = new NodalService(store, dataDir);
const connection = await startServer(service);
// Only the parent desktop/dev process reads this launch handshake. Never persist it.
process.stdout.write(JSON.stringify({ url: connection.url, token: connection.token }) + '\n');
let closing = false;
async function shutdown() { if (closing) return; closing = true; await connection.close(); store.close(); process.exit(0); }
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
process.stdin.resume(); process.stdin.on('end', () => void shutdown());
