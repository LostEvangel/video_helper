import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Locator } from '../../shared/contracts.js';
import { HlsError } from './parse.js';

export type ResolveContext = { source: Locator; baseUrl?: string };

function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function isWindowsUncPath(value: string): boolean {
  return value.startsWith('\\\\');
}

function fileLocator(value: string): Locator {
  return { kind: 'file', value };
}

function httpBase(context: ResolveContext): string | undefined {
  if (context.baseUrl) return context.baseUrl;
  return context.source.kind === 'url' ? context.source.value : undefined;
}

function validateHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HlsError('INVALID_URI', 'An HLS resource URI is not a valid absolute URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HlsError('UNSUPPORTED_URI', `The HLS resource protocol ${parsed.protocol} is not supported.`);
  }
  return parsed.href;
}

/** Resolve an HLS reference with explicit base, playlist URL, then local directory semantics. */
export function resolveResource(uri: string, context: ResolveContext): Locator {
  const reference = uri.trim();
  if (!reference) throw new HlsError('INVALID_URI', 'An HLS resource URI is empty.');

  if (context.source.kind === 'url'
    && (isWindowsDrivePath(reference) || isWindowsUncPath(reference) || /^file:/i.test(reference))) {
    throw new HlsError('UNSUPPORTED_URI', 'An HTTP(S) HLS playlist cannot reference a local file or network share.');
  }

  // Drive and UNC paths must be recognized before the URI-scheme test: "C:" is not a scheme here.
  if (isWindowsDrivePath(reference) || isWindowsUncPath(reference)) return fileLocator(path.win32.normalize(reference));

  if (/^file:/i.test(reference)) {
    try {
      return fileLocator(fileURLToPath(reference));
    } catch {
      throw new HlsError('INVALID_URI', 'An HLS file URI is not a valid local path.');
    }
  }

  if (/^https?:/i.test(reference)) return { kind: 'url', value: validateHttpUrl(reference) };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)) {
    throw new HlsError('UNSUPPORTED_URI', 'Only HTTP, HTTPS, file, and local HLS resource URIs are supported.');
  }

  const base = httpBase(context);
  if (base) {
    let baseUrl: URL;
    try {
      baseUrl = new URL(base);
    } catch {
      throw new HlsError('INVALID_BASE_URL', 'The HLS base URL is invalid.');
    }
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      throw new HlsError('INVALID_BASE_URL', 'The HLS base URL must use HTTP or HTTPS.');
    }
    try {
      return { kind: 'url', value: validateHttpUrl(new URL(reference, baseUrl).href) };
    } catch (error) {
      if (error instanceof HlsError) throw error;
      throw new HlsError('INVALID_URI', 'The HLS resource URI cannot be resolved against its base URL.');
    }
  }

  if (reference.startsWith('//')) {
    throw new HlsError('NO_BASE_URL', 'A protocol-relative HLS resource needs an HTTP or HTTPS base URL.');
  }
  if (context.source.kind === 'url') {
    throw new HlsError('NO_BASE_URL', 'The HLS playlist does not have a usable HTTP base URL.');
  }

  const sourcePath = context.source.value;
  if (isWindowsDrivePath(sourcePath) || isWindowsUncPath(sourcePath)) {
    return fileLocator(path.win32.resolve(path.win32.dirname(sourcePath), reference));
  }
  if (path.isAbsolute(sourcePath)) return fileLocator(path.resolve(path.dirname(sourcePath), reference));
  if (path.win32.isAbsolute(sourcePath)) return fileLocator(path.win32.resolve(path.win32.dirname(sourcePath), reference));
  throw new HlsError('INVALID_SOURCE', 'A local playlist path must be absolute before resolving relative resources.');
}
