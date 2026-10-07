import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DownloadManifest, Resource } from '../../shared/contracts.js';
import { resourceCachePath } from '../download/queue.js';
import { HlsError, formatAttributeList, parsePlaylist, type HlsAttributes } from './parse.js';
import { resolveResource } from './resolve.js';

function resourceKey(role: Resource['role'], source: Resource['source'], range?: Resource['range']): string {
  return JSON.stringify([role, source.kind, source.value, range ?? null]);
}

function localizedText(text: string, snapshot: DownloadManifest['snapshots'][number], resources: Resource[], cacheDir: string): string {
  const context = { source: snapshot.source, ...(snapshot.baseUrl === undefined ? {} : { baseUrl: snapshot.baseUrl }) };
  const resolve = (uri: string) => resolveResource(uri, context);
  const identity = (uri: string) => {
    const source = resolve(uri);
    return `${source.kind}:${source.value}`;
  };
  const parsed = parsePlaylist(text, identity);
  if (parsed.kind !== 'media') throw new HlsError('INVALID_PLAYLIST', 'A selected HLS snapshot must be a media playlist.');
  if (!parsed.hasEndList) throw new HlsError('INCOMPLETE_PLAYLIST', 'A selected HLS snapshot has no ENDLIST tag.');
  const index = new Map(resources.map((resource) => [resourceKey(resource.role, resource.source, resource.range), resource]));

  function lookup(role: Resource['role'], uri: string, range?: Resource['range']): Resource {
    const source = resolve(uri);
    const resource = index.get(resourceKey(role, source, range));
    if (!resource) throw new HlsError('LOCALIZATION_RESOURCE_MISSING', 'The selected manifest does not contain every resource referenced by its HLS playlist.');
    return resource;
  }

  function cacheReference(resource: Resource): string {
    return path.basename(resourceCachePath(cacheDir, resource.id));
  }

  const byLine = new Map<number, string>();
  const skipLines = new Set<number>();
  for (const key of parsed.keys) {
    if (!key.uri) continue;
    const resource = lookup('key', key.uri);
    const attributes: HlsAttributes = { ...key.attributes, URI: cacheReference(resource) };
    byLine.set(key.lineIndex, `#EXT-X-KEY:${formatAttributeList(attributes)}`);
  }
  for (const map of parsed.maps) {
    const resource = lookup('init', map.uri, map.range);
    const attributes: HlsAttributes = { ...map.attributes, URI: cacheReference(resource) };
    delete attributes.BYTERANGE;
    byLine.set(map.lineIndex, `#EXT-X-MAP:${formatAttributeList(attributes)}`);
  }
  for (const segment of parsed.segments) {
    const resource = lookup('segment', segment.uri, segment.range);
    byLine.set(segment.lineIndex, cacheReference(resource));
    if (segment.rangeLineIndex !== undefined) skipLines.add(segment.rangeLineIndex);
  }

  const localized = parsed.lines
    .map((line, lineIndex) => skipLines.has(lineIndex) ? undefined : byLine.get(lineIndex) ?? line)
    .filter((line): line is string => line !== undefined)
    .join('\n')
    .replace(/\n*$/, '\n');
  if (localized.split('\n').some((line) => line.startsWith('#') && /\bURI\s*=\s*["']?(?:https?:|\/\/)/i.test(line))) {
    throw new HlsError('UNSUPPORTED_PLAYLIST_FEATURE', 'The localized HLS playlist still contains an external URI on an unsupported tag.');
  }
  return localized;
}

export async function localizeManifest(manifest: DownloadManifest, cacheDir: string): Promise<{ video: string; audio?: string }> {
  const videoSnapshot = manifest.snapshots[0];
  if (!videoSnapshot) throw new HlsError('INVALID_MANIFEST', 'The selected manifest has no video playlist snapshot.');
  const absoluteCache = path.resolve(cacheDir);
  await mkdir(absoluteCache, { recursive: true });

  const video = path.join(absoluteCache, 'video.m3u8');
  await writeFile(video, localizedText(manifest.videoText, videoSnapshot, manifest.resources, absoluteCache), 'utf8');

  if (manifest.audioText === undefined) return { video };
  const audioSnapshot = manifest.snapshots[1];
  if (!audioSnapshot) throw new HlsError('INVALID_MANIFEST', 'The selected manifest has audio text but no audio playlist snapshot.');
  const audio = path.join(absoluteCache, 'audio.m3u8');
  await writeFile(audio, localizedText(manifest.audioText, audioSnapshot, manifest.resources, absoluteCache), 'utf8');
  return { video, audio };
}
