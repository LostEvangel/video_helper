import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DownloadManifest, OutputMode, TaskView } from '../../shared/contracts.js';

export type TaskRecord = {
  manifest: DownloadManifest;
  view: TaskView;
  cacheDir: string;
  output: string;
  keepCache: boolean;
  outputMode: OutputMode;
  networkConcurrency?: number;
  completed: Record<string, {
    path: string;
    bytes: number;
    sha256: string;
    etag?: string;
    lastModified?: string;
  }>;
  queueOrder?: number;
};

export interface TaskStore {
  load(id: string): Promise<TaskRecord | undefined>;
  save(record: TaskRecord): Promise<void>;
  list(): Promise<TaskRecord[]>;
  delete?(id: string): Promise<void>;
  flush?(): Promise<void>;
}

function validateTaskId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error('Task id cannot be used as a store filename.');
}

function recordFilePattern(id: string): RegExp {
  return new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d{16})-[a-f0-9-]{36}\\.json$`);
}

export class FileTaskStore implements TaskStore {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async load(id: string): Promise<TaskRecord | undefined> {
    validateTaskId(id);
    await this.writeTail;
    const latest = await this.latestFile(id);
    if (!latest) return undefined;
    return JSON.parse(await readFile(path.join(this.directory, latest.name), 'utf8')) as TaskRecord;
  }

  async save(record: TaskRecord): Promise<void> {
    validateTaskId(record.manifest.id);
    const write = async () => {
      await mkdir(this.directory, { recursive: true });
      const previous = await this.filesFor(record.manifest.id);
      const generation = Math.max(0, ...previous.map((item) => item.generation)) + 1;
      const stem = `${record.manifest.id}.${String(generation).padStart(16, '0')}-${randomUUID()}`;
      const target = path.join(this.directory, `${stem}.json`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, target);
        await Promise.all(previous.map((item) => rm(path.join(this.directory, item.name), { force: true })));
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    };
    const pending = this.writeTail.then(write, write);
    this.writeTail = pending.catch(() => {});
    return pending;
  }

  async list(): Promise<TaskRecord[]> {
    await this.writeTail;
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const ids = new Set<string>();
    for (const name of names) {
      const match = /^([A-Za-z0-9_-]{1,160})\.\d{16}-[a-f0-9-]{36}\.json$/.exec(name);
      if (match?.[1]) ids.add(match[1]);
    }
    const records = await Promise.all([...ids].sort().map((id) => this.load(id)));
    return records.filter((record): record is TaskRecord => record !== undefined);
  }

  async delete(id: string): Promise<void> {
    validateTaskId(id);
    const remove = async () => {
      for (const item of await this.filesFor(id)) await rm(path.join(this.directory, item.name), { force: true });
    };
    const pending = this.writeTail.then(remove, remove).then(() => undefined);
    this.writeTail = pending.catch(() => {});
    return pending;
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }

  private async filesFor(id: string): Promise<Array<{ name: string; generation: number }>> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const pattern = recordFilePattern(id);
    return names.flatMap((name) => {
      const generation = pattern.exec(name)?.[1];
      return generation === undefined ? [] : [{ name, generation: Number(generation) }];
    });
  }

  private async latestFile(id: string): Promise<{ name: string; generation: number } | undefined> {
    return (await this.filesFor(id)).sort((a, b) => b.generation - a.generation)[0];
  }
}
