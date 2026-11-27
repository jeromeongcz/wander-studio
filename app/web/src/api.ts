export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined, ...init });
  } catch {
    throw new ApiError(0, 'OFFLINE', 'Cannot reach the local server. Is it running (npm run dev:server)?');
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  // the page is newer than the running server: say what to do instead of a bare 404
  if (res.status === 404 && typeof json?.message === 'string' && json.message.startsWith('Route ')) throw new ApiError(404, 'OUTDATED_SERVER', 'The server is out of date. Stop it (Ctrl+C in its terminal), run npm start again, then refresh this page.');
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'ERROR', json?.error?.message ?? `HTTP ${res.status}`, json?.error?.details);
  return json as T;
}

export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, b: unknown = {}) => request<T>('POST', p, b),
  put: <T = any>(p: string, b: unknown) => request<T>('PUT', p, b),
  patch: <T = any>(p: string, b: unknown) => request<T>('PATCH', p, b),
  del: <T = any>(p: string) => request<T>('DELETE', p),
  /** Send a picked file to the server's temp area; returns the server-side path to pass to an import call. */
  async postBinary<T>(path: string, body: Blob): Promise<T> {
    return request('POST', path, undefined, { headers: { 'content-type': 'application/octet-stream' }, body });
  },
  async upload(file: File): Promise<{ path: string; bytes: number; name: string }> {
    return request('POST', '/uploads', undefined, { headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) }, body: file });
  },
};

export const url = (p: string) => `/api${p}`;
