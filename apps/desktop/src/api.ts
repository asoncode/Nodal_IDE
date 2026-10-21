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

export async function api<T = unknown>(method: string, params: Record<string, unknown> = {}, options: { keepalive?: boolean } = {}): Promise<T> {
  const { url, token } = await connect();
  const response = await fetch(`${url.replace(/\/$/, '')}/api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ method, params }), keepalive: options.keepalive,
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message || `Request failed (${response.status})`);
  return body.result as T;
}
