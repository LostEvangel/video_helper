import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Resource } from '../../src/shared/contracts.js';

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

export type TestServerOptions = {
  data?: string | Uint8Array;
  dataByPath?: Record<string, string | Uint8Array>;
  beforeRespond?: (pathname: string) => Promise<void> | void;
  status?: number;
  firstStatus?: number;
  statusSequence?: number[];
  delayMs?: number | ((pathname: string) => number);
  truncateBytes?: number;
  ignoreRange?: boolean;
  wrongContentRange?: boolean;
  omitContentLength?: boolean;
};

export type TestServer = {
  resource: Resource;
  readonly requests: number;
  readonly responses: number;
  readonly maxConcurrent: number;
  readonly requestPaths: readonly string[];
  close(): Promise<void>;
};

export async function makeServer(options: TestServerOptions = {}): Promise<TestServer> {
  const data = Buffer.from(options.data ?? 'download resource');
  let requests = 0;
  let responses = 0;
  let active = 0;
  let maxConcurrent = 0;
  const requestPaths: string[] = [];

  const server: Server = createServer((request, response) => {
    requests += 1;
    const requestNumber = requests;
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const responseData = Buffer.from(options.dataByPath?.[pathname] ?? data);
    requestPaths.push(pathname);
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    response.once('close', () => { active -= 1; });

    const finish = (status: number, body: Buffer = responseData) => {
      if (response.destroyed) return;
      responses += 1;
      response.statusCode = status;
      response.setHeader('etag', '"test-v1"');
      response.setHeader('last-modified', 'Tue, 06 Oct 2026 00:00:00 GMT');
      const range = request.headers.range;
      if (range && !options.ignoreRange && status === 200) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        if (!match) {
          response.statusCode = 416;
          response.end();
          return;
        }
        const start = Number(match[1]);
        const end = Number(match[2]);
        const selected = body.subarray(start, end + 1);
        response.statusCode = 206;
        response.setHeader('content-range', options.wrongContentRange
          ? `bytes ${start + 1}-${end + 1}/${body.length}`
          : `bytes ${start}-${end}/${body.length}`);
        if (!options.omitContentLength) response.setHeader('content-length', selected.length);
        response.end(selected);
        return;
      }
      if (!options.omitContentLength) response.setHeader('content-length', body.length);
      if (options.truncateBytes !== undefined) {
        response.setHeader('content-length', body.length);
        response.write(body.subarray(0, Math.max(0, Math.min(options.truncateBytes, body.length))));
        response.destroy();
        return;
      }
      response.end(body);
    };

    const routeDelay = typeof options.delayMs === 'function'
      ? options.delayMs(pathname)
      : (options.delayMs ?? 0);
    nativeSetTimeout(() => { void (async () => {
      await options.beforeRespond?.(pathname);
      const sequenceStatus = options.statusSequence?.[requestNumber - 1];
      if (sequenceStatus !== undefined) finish(sequenceStatus, data);
      else if (options.firstStatus !== undefined && requestNumber === 1) finish(options.firstStatus);
      else finish(options.status ?? 200, responseData);
    })().catch(() => response.destroy()); }, routeDelay);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/resource`;

  return {
    resource: { id: 'segment-test-resource', source: { kind: 'url', value: url }, role: 'segment' },
    get requests() { return requests; },
    get responses() { return responses; },
    get maxConcurrent() { return maxConcurrent; },
    get requestPaths() { return [...requestPaths]; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

export function withResourceId(resource: Resource, id: string, pathname?: string): Resource {
  const source = resource.source.kind === 'url' && pathname
    ? { ...resource.source, value: new URL(pathname, resource.source.value).href }
    : resource.source;
  return { ...resource, id, source };
}

export async function waitForRequestCount(server: TestServer, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && server.requests < count; attempt += 1) {
    await new Promise<void>((resolve) => nativeSetTimeout(resolve, 10));
  }
  if (server.requests < count) throw new Error(`Expected ${count} requests; saw ${server.requests}.`);
}

export async function waitForResponseCount(server: TestServer, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && server.responses < count; attempt += 1) {
    await new Promise<void>((resolve) => nativeSetTimeout(resolve, 10));
  }
  if (server.responses < count) throw new Error(`Expected ${count} responses; saw ${server.responses}.`);
}
