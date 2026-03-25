/* eslint-disable @typescript-eslint/no-var-requires */
import * as tls from 'tls';
import * as net from 'net';
import type * as vscode from 'vscode';

const httpMod = require('http') as typeof import('http');
const httpsMod = require('https') as typeof import('https');

const workerThreads = require('worker_threads') as typeof import('worker_threads');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');

let originalHttpCreateConnection: Function | null = null;
let originalHttpsCreateConnection: Function | null = null;
let originalWorker: any = null;
let outputChannel: vscode.OutputChannel | null = null;
let proxyPort = 0;

// Map of "host:port" → initiator extension name (for the most recent connection)
const initiatorMap = new Map<string, string>();

/**
 * Extract the initiator extension name from a stack trace.
 * Looks for .vscode/extensions/<publisher>.<name>-<version>/ in the stack.
 */
function detectInitiator(): string | undefined {
  const stack = new Error().stack || '';
  // Find ALL extension paths in the stack, skip our own
  const matches = stack.matchAll(/\.vscode\/extensions\/([^/]+)\//g);
  for (const match of matches) {
    const raw = match[1];
    // Skip our own extension
    if (raw.startsWith('abridge.http-ceptor')) continue;
    const versionMatch = raw.match(/^(.+)-\d+\.\d+\.\d+$/);
    return versionMatch ? versionMatch[1] : raw;
  }
  // Check for workspace/dev extensions
  const workspaceMatch = stack.match(/IdeaProjects\/[^/]*\/([^/]+)\//);
  if (workspaceMatch) {
    return workspaceMatch[1];
  }
  return undefined;
}

export function getInitiator(host: string, port: number): string | undefined {
  const key = `${host}:${port}`;
  const initiator = initiatorMap.get(key);
  if (initiator) {
    initiatorMap.delete(key);
  }
  return initiator;
}

export function getInitiatorByUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return getInitiator(parsed.hostname, Number(port));
  } catch {
    return undefined;
  }
}

/**
 * CONNECT tunnel through mitmproxy, then TLS handshake.
 * Returns undefined — the socket is delivered via oncreate callback only.
 * (Agent.createSocket calls oncreate(null, socket) if createConnection returns truthy,
 * which would bypass our async tunnel setup.)
 */
function createTunnelConnection(
  targetHost: string,
  targetPort: number,
  oncreate: (err: Error | null, socket?: tls.TLSSocket) => void
): undefined {
  const proxySocket = net.createConnection({ host: '127.0.0.1', port: proxyPort });

  proxySocket.once('connect', () => {
    proxySocket.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`
    );
  });

  let buf = '';
  const onData = (chunk: Buffer) => {
    buf += chunk.toString();
    if (!buf.includes('\r\n\r\n')) return;
    proxySocket.removeListener('data', onData);

    const statusLine = buf.split('\r\n')[0];
    if (!statusLine.includes(' 200 ')) {
      const err = new Error(`CONNECT tunnel failed: ${statusLine}`);
      outputChannel?.appendLine(`[http-patch] ${err.message}`);
      proxySocket.destroy();
      oncreate(err);
      return;
    }

    outputChannel?.appendLine(`[http-patch] CONNECT established for ${targetHost}:${targetPort}`);

    const tlsSocket = tls.connect({
      socket: proxySocket,
      servername: targetHost,
      rejectUnauthorized: false,
    });

    tlsSocket.once('secureConnect', () => {
      oncreate(null, tlsSocket);
    });

    tlsSocket.once('error', (err: Error) => {
      outputChannel?.appendLine(`[http-patch] TLS error: ${err.message}`);
      oncreate(err);
    });
  };

  proxySocket.on('data', onData);
  proxySocket.on('error', (err: Error) => {
    outputChannel?.appendLine(`[http-patch] Socket error: ${err.message}`);
    oncreate(err);
  });

  // Return undefined so Agent.createSocket doesn't call oncreate prematurely
  return undefined;
}

export function installHttpPatch(port: number, channel: vscode.OutputChannel): void {
  if (originalHttpCreateConnection) {
    channel.appendLine('[http-patch] Already installed, skipping.');
    return;
  }

  outputChannel = channel;
  proxyPort = port;

  originalHttpCreateConnection = httpMod.Agent.prototype.createConnection;
  originalHttpsCreateConnection = httpsMod.Agent.prototype.createConnection;

  // Patch HTTP Agent — detect if it's actually HTTPS (some libs use http.Agent for HTTPS)
  httpMod.Agent.prototype.createConnection = function patchedHttpCreate(
    options: any,
    oncreate: any
  ): any {
    const targetHost = options.hostname || options.host || 'localhost';
    const targetPort = Number(options.port) || 80;

    if (targetHost === '127.0.0.1' && targetPort === proxyPort) {
      return originalHttpCreateConnection!.call(this, options, oncreate);
    }

    const isTLS =
      targetPort === 443 ||
      options.secureEndpoint ||
      options.servername ||
      options.protocol === 'https:' ||
      options._defaultAgent?.protocol === 'https:';

    const initiator = detectInitiator();
    if (initiator) {
      initiatorMap.set(`${targetHost}:${targetPort}`, initiator);
    }

    if (isTLS) {
      outputChannel?.appendLine(
        `[http-patch] HTTPS (via http.Agent) → ${targetHost}:${targetPort} (CONNECT) [${initiator || '?'}]`
      );
      return createTunnelConnection(targetHost, targetPort, oncreate);
    }

    outputChannel?.appendLine(
      `[http-patch] HTTP → ${targetHost}:${targetPort} [${initiator || '?'}]`
    );
    return net.createConnection({ host: '127.0.0.1', port: proxyPort }, oncreate);
  };

  // Patch HTTPS Agent — always CONNECT tunnel
  httpsMod.Agent.prototype.createConnection = function patchedHttpsCreate(
    options: any,
    oncreate: any
  ): any {
    const targetHost = options.hostname || options.host || options.servername || 'localhost';
    const targetPort = Number(options.port) || 443;

    if (targetHost === '127.0.0.1' && targetPort === proxyPort) {
      return originalHttpsCreateConnection!.call(this, options, oncreate);
    }

    const initiator = detectInitiator();
    if (initiator) {
      initiatorMap.set(`${targetHost}:${targetPort}`, initiator);
    }
    outputChannel?.appendLine(
      `[http-patch] HTTPS → ${targetHost}:${targetPort} (CONNECT) [${initiator || '?'}]`
    );
    return createTunnelConnection(targetHost, targetPort, oncreate);
  };

  // Patch worker_threads.Worker to inject proxy env vars into workers
  originalWorker = workerThreads.Worker;
  const proxyUrl = `http://127.0.0.1:${port}`;
  const certPath = path.join(os.homedir(), '.mitmproxy', 'mitmproxy-ca-cert.pem');
  const OrigWorker = workerThreads.Worker;

  workerThreads.Worker = class PatchedWorker extends OrigWorker {
    constructor(filename: any, options: any = {}) {
      const env = options.env || { ...process.env };
      env.HTTP_PROXY = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;
      env.http_proxy = proxyUrl;
      env.https_proxy = proxyUrl;
      env.NODE_EXTRA_CA_CERTS = certPath;
      options.env = env;
      super(filename, options);
      outputChannel?.appendLine(`[http-patch] Worker spawned with proxy env: ${filename}`);
    }
  } as any;

  channel.appendLine(
    `[http-patch] Installed — Agent.prototype.createConnection + Worker patched (port ${port})`
  );
}

export function removeHttpPatch(): void {
  if (originalHttpCreateConnection) {
    httpMod.Agent.prototype.createConnection = originalHttpCreateConnection as any;
    originalHttpCreateConnection = null;
  }
  if (originalHttpsCreateConnection) {
    httpsMod.Agent.prototype.createConnection = originalHttpsCreateConnection as any;
    originalHttpsCreateConnection = null;
  }
  if (originalWorker) {
    workerThreads.Worker = originalWorker;
    originalWorker = null;
  }
  outputChannel?.appendLine(
    '[http-patch] Removed — Agent.prototype.createConnection + Worker restored.'
  );
  outputChannel = null;
}

export function isHttpPatchInstalled(): boolean {
  return originalHttpCreateConnection !== null;
}
