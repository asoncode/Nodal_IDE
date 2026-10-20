import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { NodalService } from './service.js';
import { redact } from '../../persistence/src/index.js';
const requestSchema = z.object({ method: z.string().min(1).max(80), params: z.record(z.string(), z.unknown()).default({}) }).strict();
const defaultOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];
function authorized(request: IncomingMessage, token: string) {
  const supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const candidate = Buffer.from(supplied); const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
export async function startServer(service: NodalService, options: { port?: number; origins?: string[]; token?: string } = {}) {
  const token = options.token ?? randomBytes(32).toString('hex');
  const origins = new Set(options.origins ?? defaultOrigins);
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    // Browser callers must have an allowlisted origin; local API clients still need the launch token.
    if ((origin && !origins.has(origin)) || !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '')) { res.writeHead(403).end(); return; }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'POST'); res.writeHead(204).end(); return; }
    if (req.url !== '/api' || req.method !== 'POST') { res.writeHead(404).end(JSON.stringify({ error: 'Not found' })); return; }
    if (!authorized(req, token)) { res.writeHead(401).end(JSON.stringify({ error: 'A valid per-launch token is required' })); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415).end(JSON.stringify({ error: 'JSON required' })); return; }
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 3 * 1024 * 1024) throw new Error('Request exceeds 3 MiB'); chunks.push(chunk); }
      const body = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const result = await service.dispatch(body.method, body.params);
      res.end(JSON.stringify({ result }));
    } catch (error) { res.writeHead(400).end(JSON.stringify({ error: redact(error instanceof Error ? error.message : String(error)) })); }
  });
  server.requestTimeout = 150000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => resolve()); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Local server did not bind');
  return { url: `http://127.0.0.1:${address.port}`, token, server,
    close: async () => { await service.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); },
  };
}
