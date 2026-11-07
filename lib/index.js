import { AccountError, MAX_BYTES, listAccounts, previewImport, importAccounts, exportAccounts } from './vault.js';

export const name = 'codex-account-tools';
export const inject = ['credentials'];
export const ENDPOINTS = ['accounts/list', 'accounts/preview', 'accounts/import', 'accounts/export'];

export function createHandler(credentials) {
  return async (endpoint, input = {}) => {
    try {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new AccountError('INPUT', '请求参数格式不正确。');
      let value;
      if (endpoint === 'accounts/list') value = await listAccounts(credentials);
      else if (endpoint === 'accounts/preview') value = await previewImport(credentials, input.text);
      else if (endpoint === 'accounts/import') value = await importAccounts(credentials, input);
      else if (endpoint === 'accounts/export') value = await exportAccounts(credentials, input);
      else throw new AccountError('ENDPOINT', '不支持该操作。');
      return { ok: true, value };
    } catch (error) {
      // Never return host exception messages, input JSON, tokens or stack traces to the UI.
      return { ok: false, error: { code: error instanceof AccountError ? error.code : 'STORAGE', message: error instanceof AccountError ? error.message : '无法访问 DSH 账号库，请检查凭据服务后重试。', details: {} } };
    }
  };
}

export function registerTransport(connection, handler) {
  const disposers = [];
  try {
    for (const endpoint of ENDPOINTS) {
      const method = `codex-account-tools/${endpoint}`;
      disposers.push(connection.fetch.register({
        path: `/api/${method}`, methods: ['POST'], requestBody: 'buffered',
        async fetch(request) {
          const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
          if (type !== 'application/json') return new Response('application/json required', { status: 415 });
          if (Number(request.headers.get('content-length')) > MAX_BYTES + 65536) return new Response('request too large', { status: 413 });
          let body;
          try {
            const text = await request.text();
            if (Buffer.byteLength(text) > MAX_BYTES + 65536) return new Response('request too large', { status: 413 });
            body = JSON.parse(text);
          } catch { return new Response('invalid JSON', { status: 400 }); }
          if (!body || body.type !== 'client-request' || typeof body.rpcId !== 'string' || !body.rpcId || body.rpcId.length > 256 || body.method !== method) return new Response('invalid RPC envelope', { status: 400 });
          request.signal.throwIfAborted();
          const result = await handler(endpoint, body.payload);
          return Response.json({ type: 'server-response', rpcId: body.rpcId, result }, { headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' } });
        }
      }));
    }
  } catch (error) {
    for (const d of disposers.reverse()) d();
    throw error;
  }
  return () => { for (const d of disposers.reverse()) d(); };
}

export function apply(ctx) {
  const handler = createHandler(ctx.credentials);
  ctx.inject(['connection'], (scope) => scope.effect(
    () => registerTransport(scope.connection, handler), 'codex-account-tools: authenticated account RPC'
  ));
}
