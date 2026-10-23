// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  history.replaceState(null, '', '/?project=example#token=test-token&port=43123');
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('local runtime API transport', () => {
  it('explains WebKit fetch failures without leaking the connection or retrying the POST', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Load failed'));
    vi.stubGlobal('fetch', fetch);
    const { api } = await import('./api.js');
    await expect(api('generation.start')).rejects.toThrow('Could not reach the local runtime for generation.start. Check that the desktop app or pnpm dev is running, then try again.');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('explains an interrupted response body', async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('Load failed')); } }));
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);
    const { api } = await import('./api.js');
    await expect(api('generation.status')).rejects.toThrow('The local runtime response was interrupted during generation.status.');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { error: 'Provider API key is invalid' },
    { error: { message: 'Provider rate limit exceeded' } },
  ])('preserves a valid backend error: %j', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status: 400 })));
    const { api } = await import('./api.js');
    const message = typeof body.error === 'string' ? body.error : body.error.message;
    await expect(api('generation.start')).rejects.toThrow(message);
  });

  it.each([502, 200])('reports HTTP %s for non-JSON responses without showing HTML', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>private proxy detail</html>', { status })));
    const { api } = await import('./api.js');
    await expect(api('generation.status')).rejects.toThrow(`Request failed (${status}) for generation.status: the local runtime returned an invalid JSON response.`);
  });

  it('passes the signal to fetch and preserves caller cancellation', async () => {
    const controller = new AbortController();
    const aborted = new DOMException('The operation was aborted.', 'AbortError');
    const fetch = vi.fn().mockImplementation(async (_url, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      throw aborted;
    });
    vi.stubGlobal('fetch', fetch);
    const { api } = await import('./api.js');
    await expect(api('generation.status', {}, { signal: controller.signal })).rejects.toBe(aborted);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('treats response-stream cancellation as AbortError even if WebKit reports Load failed', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => {
      controller.abort();
      throw new TypeError('Load failed');
    } }));
    const { api } = await import('./api.js');
    await expect(api('generation.status', {}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns results, forwards keepalive, caches the browser connection, and removes its fragment', async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({ result: { ready: true } }));
    vi.stubGlobal('fetch', fetch);
    const { api } = await import('./api.js');
    await expect(api('runtime.status', { projectId: 'example' }, { keepalive: true })).resolves.toEqual({ ready: true });
    expect(location.hash).toBe('');
    expect(location.pathname + location.search).toBe('/?project=example');
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:43123/api', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ method: 'runtime.status', params: { projectId: 'example' } }), keepalive: true,
    }));
    await expect(api('runtime.status')).resolves.toEqual({ ready: true });
  });

  it('continues to obtain the native connection through Tauri', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    invoke.mockResolvedValue({ url: 'http://127.0.0.1:43124/', token: 'native-test-token' });
    const fetch = vi.fn().mockResolvedValue(Response.json({ result: true }));
    vi.stubGlobal('fetch', fetch);
    const { api } = await import('./api.js');
    await expect(api('runtime.status')).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('connection');
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:43124/api', expect.any(Object));
  });
});
