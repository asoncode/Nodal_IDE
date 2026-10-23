let connection: { url: string; token: string } | undefined;

export async function connect() {
  if (connection) return connection;
  if ('__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    connection = await invoke('connection');
  } else {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get('token');
    const port = fragment.get('port');
    if (token && port && /^\d+$/.test(port)) {
      connection = { url: `http://127.0.0.1:${port}`, token };
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }
  if (!connection) throw new Error('No local runtime connection. Launch with pnpm dev or open the desktop app.');
  return connection;
}

export async function api<T = unknown>(method: string, params: Record<string, unknown> = {}, options: { keepalive?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const { url, token } = await connect();
  const request = /^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(method) ? method : 'API request';
  const transportError = (error: unknown, interrupted: boolean) => {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return error;
    if (options.signal?.aborted) return new DOMException('The request was aborted.', 'AbortError');
    return new Error(interrupted
      ? `The local runtime response was interrupted during ${request}. Check that the desktop app or pnpm dev is still running, then try again.`
      : `Could not reach the local runtime for ${request}. Check that the desktop app or pnpm dev is running, then try again.`);
  };
  let response: Response;
  try {
    response = await fetch(`${url.replace(/\/$/, '')}/api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ method, params }), keepalive: options.keepalive, signal: options.signal,
    });
  } catch (error) {
    throw transportError(error, false);
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError && !options.signal?.aborted) throw new Error(`Request failed (${response.status}) for ${request}: the local runtime returned an invalid JSON response.`);
    throw transportError(error, true);
  }
  if (!body || typeof body !== 'object') throw new Error(`Request failed (${response.status}) for ${request}: the local runtime returned an invalid API response.`);
  if (!response.ok || body.error) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message || `Request failed (${response.status})`);
  return body.result as T;
}
