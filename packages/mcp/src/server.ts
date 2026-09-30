import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Hub } from '@acr/core/hub.js';
import { localServer, remoteServer } from './tools.js';

export const MCP_PATH = '/mcp';
const MAX_BODY = 4 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/**
 * One MCP endpoint on its own port, bound to 127.0.0.1 (SPEC §14, ADR-0004). Stateless:
 * a fresh MCP server + transport per request, so there is no session state to leak between callers.
 */
function endpointServer(opts: {
  build: () => McpServer;
  port: number;
  token?: string;
  /** Evaluated per request, so an ephemeral port (0) is known once listening. */
  allowedHosts?: () => string[] | undefined;
  label: string;
  log: (line: string) => void;
}): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, endpoint: opts.label });
    if (url.pathname !== MCP_PATH) return send(res, 404, { error: 'not found' });
    if (opts.token) {
      const auth = req.headers.authorization ?? '';
      const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!sameSecret(given, opts.token)) return send(res, 401, { error: 'missing or invalid bearer token' });
    }
    if (req.method !== 'POST') {
      // Stateless server: no standalone SSE stream and no sessions to delete.
      return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (e) {
      return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: (e as Error).message }, id: null });
    }
    const hosts = opts.allowedHosts?.();
    const server = opts.build();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      ...(hosts?.length ? { enableDnsRebindingProtection: true, allowedHosts: hosts } : {}),
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      opts.log(`[${opts.label}] ${(e as Error).message}`);
      if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
    }
  });
}

export type RunningHub = { remoteUrl: string; localUrl: string; close(): Promise<void> };

export async function startHubServers(opts: {
  hub: Hub;
  name: string;
  ports: { remote: number; local: number };
  localToken: string;
  /** Extra Host header values accepted on the remote endpoint (a bridge may forward its own). */
  remoteHosts?: string[];
  log?: (line: string) => void;
}): Promise<RunningHub> {
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const hosts = (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`];
  let remotePort = opts.ports.remote;
  let localPort = opts.ports.local;
  const remote = endpointServer({
    build: () => remoteServer(opts.hub, opts.name),
    port: opts.ports.remote,
    // DNS-rebinding protection is always on; a bridge that forwards its own Host adds it via remoteHosts.
    allowedHosts: () => [...hosts(remotePort), ...(opts.remoteHosts ?? [])],
    label: 'remote',
    log,
  });
  const local = endpointServer({
    build: () => localServer(opts.hub, opts.name),
    port: opts.ports.local,
    token: opts.localToken,
    allowedHosts: () => hosts(localPort),
    label: 'local',
    log,
  });
  const listen = (s: Server, port: number) =>
    new Promise<number>((resolve, reject) => {
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => {
        const addr = s.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  remotePort = await listen(remote, opts.ports.remote);
  localPort = await listen(local, opts.ports.local);
  const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));
  return {
    remoteUrl: `http://127.0.0.1:${remotePort}${MCP_PATH}`,
    localUrl: `http://127.0.0.1:${localPort}${MCP_PATH}`,
    close: async () => {
      remote.closeAllConnections?.();
      local.closeAllConnections?.();
      await Promise.all([close(remote), close(local)]);
    },
  };
}
