import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  AudioTrack,
  DownloadManifest,
  InputSource,
  Inspection,
  Locator,
  Resource,
  Variant,
} from '../../shared/contracts.js';
import { HlsError, parsePlaylist, type MediaPlaylist } from './parse.js';
import { resolveResource } from './resolve.js';

type LoadedPlaylist = { source: Locator; text: string; baseUrl?: string };
type AudioRecord = { track: AudioTrack; groupKey: string; source?: Locator; isDefault: boolean };
type VariantRecord = { variant: Variant; media: LoadedPlaylist; audioIds: string[]; mediaData: MediaPlaylist; parentSnapshots: LoadedPlaylist[] };
type InspectionRecord = {
  inspection: Inspection;
  variants: Map<string, VariantRecord>;
  audio: Map<string, AudioRecord>;
};

const inspections = new Map<string, InspectionRecord>();
const MAX_PARSED_INSPECTIONS = 64;
const MAX_MASTER_DEPTH = 8;

function contextFor(loaded: LoadedPlaylist): { source: Locator; baseUrl?: string } {
  return { source: loaded.source, ...(loaded.baseUrl === undefined ? {} : { baseUrl: loaded.baseUrl }) };
}

function resourceIdentityFor(loaded: LoadedPlaylist, uri: string): string {
  const resolved = resolveResource(uri, contextFor(loaded));
  return `${resolved.kind}:${resolved.value}`;
}

function canonicalLocator(locator: Locator): string {
  if (locator.kind === 'url') {
    try {
      const parsed = new URL(locator.value);
      parsed.hash = '';
      return parsed.href;
    } catch {
      return locator.value;
    }
  }
  return locator.value.replaceAll('/', '\\').replace(/\\+$/, '').toLocaleLowerCase('en-US');
}

async function loadPlaylist(locator: Locator, baseUrl?: string): Promise<LoadedPlaylist> {
  if (locator.kind === 'file') {
    try {
      return { source: locator, text: await readFile(locator.value, 'utf8'), ...(baseUrl === undefined ? {} : { baseUrl }) };
    } catch {
      throw new HlsError('PLAYLIST_READ_FAILED', 'The local HLS playlist could not be read.');
    }
  }

  let requestUrl: URL;
  try {
    requestUrl = new URL(locator.value);
  } catch {
    throw new HlsError('UNSUPPORTED_URI', 'A remote HLS playlist must use an HTTP or HTTPS URL.');
  }
  if (requestUrl.protocol !== 'http:' && requestUrl.protocol !== 'https:') {
    throw new HlsError('UNSUPPORTED_URI', 'A remote HLS playlist must use an HTTP or HTTPS URL.');
  }

  let response: Response;
  try {
    response = await fetch(requestUrl.href, { redirect: 'follow' });
  } catch {
    throw new HlsError('PLAYLIST_FETCH_FAILED', 'The HLS playlist could not be reached. Check the URL and network connection.');
  }
  if (!response.ok) {
    throw new HlsError('PLAYLIST_FETCH_FAILED', `The HLS server returned HTTP ${response.status} for a playlist.`);
  }
  let responseUrl: URL;
  try {
    responseUrl = new URL(response.url || requestUrl.href);
  } catch {
    throw new HlsError('UNSUPPORTED_URI', 'An HTTP(S) HLS playlist redirect must remain on HTTP or HTTPS.');
  }
  if (responseUrl.protocol !== 'http:' && responseUrl.protocol !== 'https:') {
    throw new HlsError('UNSUPPORTED_URI', 'An HTTP(S) HLS playlist redirect must remain on HTTP or HTTPS.');
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new HlsError('PLAYLIST_FETCH_FAILED', 'The HLS playlist response could not be read.');
  }
  return { source: { kind: 'url', value: responseUrl.href }, text };
}

function labelFor(attributes: Record<string, string>): string {
  return attributes.NAME
    ?? attributes.RESOLUTION
    ?? (attributes.BANDWIDTH ? `${attributes.BANDWIDTH} bps` : 'HLS variant');
}

function addResource(resources: Map<string, Resource>, role: Resource['role'], source: Locator, range?: { offset: number; length: number }): Resource {
  const identity = JSON.stringify([role, source.kind, source.value, range ?? null]);
  const id = `${role}-${createHash('sha256').update(identity).digest('hex')}`;
  const previous = resources.get(id);
  if (previous) return previous;
  const resource: Resource = { id, source, role, ...(range === undefined ? {} : { range }) };
  resources.set(id, resource);
  return resource;
}

function collectMediaResources(media: LoadedPlaylist, parsed: MediaPlaylist, resources: Map<string, Resource>): void {
  const context = contextFor(media);
  for (const key of parsed.keys) {
    if (!key.uri) continue;
    addResource(resources, 'key', resolveResource(key.uri, context));
  }
  for (const map of parsed.maps) {
    addResource(resources, 'init', resolveResource(map.uri, context), map.range);
  }
  for (const segment of parsed.segments) {
    addResource(resources, 'segment', resolveResource(segment.uri, context), segment.range);
  }
}

function playlistSnapshot(loaded: LoadedPlaylist): DownloadManifest['snapshots'][number] {
  return { source: loaded.source, text: loaded.text, ...(loaded.baseUrl === undefined ? {} : { baseUrl: loaded.baseUrl }) };
}

export async function inspectInput(source: InputSource): Promise<Inspection> {
  const root: Locator = source.kind === 'url'
    ? { kind: 'url', value: source.url }
    : { kind: 'file', value: source.path };
  const rootBase = source.kind === 'file' ? source.baseUrl : undefined;
  const inspectionId = randomUUID();
  const variants: Variant[] = [];
  const variantRecords = new Map<string, VariantRecord>();
  const audioTracks: AudioTrack[] = [];
  const audioRecords = new Map<string, AudioRecord>();
  const tracksByGroup = new Map<string, string[]>();

  async function expand(
    locator: Locator,
    explicitBaseUrl: string | undefined,
    depth: number,
    ancestry: string[],
    inheritedAudioGroup?: string,
    prefix = '',
    preloaded?: LoadedPlaylist,
    parentSnapshots: LoadedPlaylist[] = [],
  ): Promise<void> {
    if (depth > MAX_MASTER_DEPTH) throw new HlsError('PLAYLIST_DEPTH_EXCEEDED', 'The HLS master playlist nesting exceeds eight levels.');
    const loaded = preloaded ?? await loadPlaylist(locator, explicitBaseUrl);
    const canonical = canonicalLocator(loaded.source);
    if (ancestry.includes(canonical)) throw new HlsError('PLAYLIST_CYCLE', 'The HLS master playlist contains a recursive reference.');
    const nextAncestry = [...ancestry, canonical];
    const parsed = parsePlaylist(loaded.text, (uri) => resourceIdentityFor(loaded, uri));

    if (parsed.kind === 'media') {
      const variantId = `${inspectionId}:variant:${variants.length}`;
      const variant: Variant = {
        id: variantId,
        label: prefix || 'HLS media playlist',
        uri: loaded.source,
      };
      const audioIds = inheritedAudioGroup ? (tracksByGroup.get(inheritedAudioGroup) ?? []) : [];
      variants.push(variant);
      variantRecords.set(variantId, { variant, media: loaded, audioIds, mediaData: parsed, parentSnapshots });
      return;
    }

    const groupKeys = new Map<string, string>();
    for (const audio of parsed.audio) {
      const attributes = audio.attributes;
      const groupId = attributes['GROUP-ID'];
      const name = attributes.NAME;
      if (!groupId || !name) throw new HlsError('INVALID_PLAYLIST', 'An audio rendition is missing GROUP-ID or NAME.');
      const groupKey = `${canonical}::${groupId}`;
      groupKeys.set(groupId, groupKey);
      const trackId = `${inspectionId}:audio:${audioTracks.length}`;
      let uri: Locator | undefined;
      if (attributes.URI) uri = resolveResource(attributes.URI, contextFor(loaded));
      const track: AudioTrack = { id: trackId, label: name, groupId, ...(uri === undefined ? {} : { uri }) };
      audioTracks.push(track);
      audioRecords.set(trackId, {
        track,
        groupKey,
        isDefault: attributes.DEFAULT?.toUpperCase() === 'YES',
        ...(uri === undefined ? {} : { source: uri }),
      });
      const group = tracksByGroup.get(groupKey) ?? [];
      group.push(trackId);
      tracksByGroup.set(groupKey, group);
    }

    for (const item of parsed.variants) {
      const ownAudioGroup = item.attributes.AUDIO ? groupKeys.get(item.attributes.AUDIO) : undefined;
      const audioGroup = ownAudioGroup ?? inheritedAudioGroup;
      const resolved = resolveResource(item.uri, contextFor(loaded));
      const childLoaded = await loadPlaylist(resolved);
      if (depth + 1 > MAX_MASTER_DEPTH) throw new HlsError('PLAYLIST_DEPTH_EXCEEDED', 'The HLS master playlist nesting exceeds eight levels.');
      const childCanonical = canonicalLocator(childLoaded.source);
      if (nextAncestry.includes(childCanonical)) throw new HlsError('PLAYLIST_CYCLE', 'The HLS master playlist contains a recursive reference.');
      const child = parsePlaylist(childLoaded.text, (uri) => resourceIdentityFor(childLoaded, uri));
      const label = [prefix, labelFor(item.attributes)].filter(Boolean).join(' / ');

      if (child.kind === 'master') {
        await expand(childLoaded.source, undefined, depth + 1, nextAncestry, audioGroup, label, childLoaded, [...parentSnapshots, loaded]);
      } else {
        const variantId = `${inspectionId}:variant:${variants.length}`;
        const variant: Variant = { id: variantId, label, uri: childLoaded.source };
        const audioIds = audioGroup ? (tracksByGroup.get(audioGroup) ?? []) : [];
        variants.push(variant);
        variantRecords.set(variantId, { variant, media: childLoaded, audioIds, mediaData: child, parentSnapshots: [...parentSnapshots, loaded] });
      }
    }
  }

  await expand(root, rootBase, 0, []);
  const only = variants.length === 1 ? variantRecords.get(variants[0]?.id ?? '') : undefined;
  const inspection: Inspection = {
    id: inspectionId,
    variants,
    audioTracks,
    ...(only ? { duration: only.mediaData.duration, segmentCount: only.mediaData.segments.length } : {}),
    ...(only?.mediaData.segments[0] ? { example: only.mediaData.segments[0].uri } : {}),
  };
  inspections.set(inspectionId, { inspection, variants: variantRecords, audio: audioRecords });
  while (inspections.size > MAX_PARSED_INSPECTIONS) {
    const oldest = inspections.keys().next().value;
    if (oldest === undefined) break;
    inspections.delete(oldest);
  }
  return inspection;
}

type AudioMediaResult = { loaded: LoadedPlaylist; parsed: MediaPlaylist; parentSnapshots: LoadedPlaylist[] };

async function loadAudioMedia(locator: Locator, depth = 0, ancestry: string[] = []): Promise<AudioMediaResult> {
  if (depth > MAX_MASTER_DEPTH) throw new HlsError('PLAYLIST_DEPTH_EXCEEDED', 'The HLS audio playlist nesting exceeds eight levels.');
  const loaded = await loadPlaylist(locator);
  const canonical = canonicalLocator(loaded.source);
  if (ancestry.includes(canonical)) throw new HlsError('PLAYLIST_CYCLE', 'The HLS audio playlist contains a recursive reference.');
  const parsed = parsePlaylist(loaded.text, (uri) => resourceIdentityFor(loaded, uri));
  if (parsed.kind === 'media') return { loaded, parsed, parentSnapshots: [] };
  const first = parsed.variants[0];
  if (!first) throw new HlsError('INVALID_PLAYLIST', 'The HLS audio master has no selectable variant.');
  const result = await loadAudioMedia(resolveResource(first.uri, contextFor(loaded)), depth + 1, [...ancestry, canonical]);
  return { ...result, parentSnapshots: [loaded, ...result.parentSnapshots] };
}

export async function selectManifest(inspectionId: string, variantId: string, audioId?: string): Promise<DownloadManifest> {
  const record = inspections.get(inspectionId);
  if (!record) throw new HlsError('INSPECTION_NOT_FOUND', 'This HLS inspection is no longer available. Inspect the playlist again.');
  const selectedVariant = record.variants.get(variantId);
  if (!selectedVariant) throw new HlsError('VARIANT_NOT_FOUND', 'The selected HLS variant does not belong to this inspection.');

  let selectedAudioId = audioId;
  if (!selectedAudioId) {
    const associated = selectedVariant.audioIds.map((id) => record.audio.get(id)).filter((item): item is AudioRecord => Boolean(item));
    const defaultTrack = associated.find((item) => item.isDefault);
    selectedAudioId = defaultTrack?.track.id ?? (associated.length === 1 ? associated[0]?.track.id : undefined);
  }
  let audioRecord: AudioRecord | undefined;
  if (selectedAudioId) {
    audioRecord = record.audio.get(selectedAudioId);
    if (!audioRecord || !selectedVariant.audioIds.includes(selectedAudioId)) {
      throw new HlsError('AUDIO_TRACK_NOT_AVAILABLE', 'The selected audio track is not associated with this HLS variant.');
    }
  }

  if (!selectedVariant.mediaData.hasEndList) {
    throw new HlsError('INCOMPLETE_PLAYLIST', 'The selected HLS media playlist is not complete because it has no ENDLIST tag.');
  }

  let audioMedia: AudioMediaResult | undefined;
  if (audioRecord?.source) {
    audioMedia = await loadAudioMedia(audioRecord.source);
    if (!audioMedia.parsed.hasEndList) {
      throw new HlsError('INCOMPLETE_PLAYLIST', 'The selected HLS audio playlist is not complete because it has no ENDLIST tag.');
    }
  }

  const resources = new Map<string, Resource>();
  collectMediaResources(selectedVariant.media, selectedVariant.mediaData, resources);
  if (audioMedia) collectMediaResources(audioMedia.loaded, audioMedia.parsed, resources);
  const snapshots = [playlistSnapshot(selectedVariant.media), ...(audioMedia ? [playlistSnapshot(audioMedia.loaded)] : [])];
  const includedSnapshots = new Set(snapshots.map((snapshot) => JSON.stringify([snapshot.source, snapshot.baseUrl ?? null, snapshot.text])));
  for (const parent of [...selectedVariant.parentSnapshots, ...(audioMedia?.parentSnapshots ?? [])]) {
    const snapshot = playlistSnapshot(parent);
    const identity = JSON.stringify([snapshot.source, snapshot.baseUrl ?? null, snapshot.text]);
    if (!includedSnapshots.has(identity)) {
      snapshots.push(snapshot);
      includedSnapshots.add(identity);
    }
  }
  const snapshotHash = createHash('sha256').update(JSON.stringify(snapshots.map((snapshot) => [snapshot.source, snapshot.baseUrl ?? null, snapshot.text]))).digest('hex');
  const manifest: DownloadManifest = {
    id: randomUUID(),
    resources: [...resources.values()],
    videoText: selectedVariant.media.text,
    ...(audioMedia === undefined ? {} : { audioText: audioMedia.loaded.text }),
    duration: selectedVariant.mediaData.duration,
    snapshotHash,
    snapshots,
  };
  return manifest;
}
