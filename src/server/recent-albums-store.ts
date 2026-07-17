import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";

const RecentAlbumRecordSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().min(1),
  canonicalPath: z.string().min(1),
  lastOpenedAt: z.string().datetime(),
  photoCount: z.number().int().nonnegative().default(0),
  ratedCount: z.number().int().nonnegative().default(0),
}).strict();
const DocumentSchema = z.object({ version: z.literal(1), albums: z.array(RecentAlbumRecordSchema) }).strict();

export type RecentAlbumRecord = z.infer<typeof RecentAlbumRecordSchema>;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class RecentAlbumsStore {
  readonly #path: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string) { this.#path = resolve(path); }

  async #read(): Promise<RecentAlbumRecord[]> {
    try {
      return DocumentSchema.parse(JSON.parse(await readFile(this.#path, "utf8"))).albums;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return [];
      try { await rename(this.#path, `${this.#path}.corrupt-${Date.now()}-${randomUUID()}`); } catch { /* best effort */ }
      return [];
    }
  }

  async #write(albums: RecentAlbumRecord[]): Promise<void> {
    const parent = dirname(this.#path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    const temporary = `${this.#path}.tmp-${randomUUID()}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(DocumentSchema.parse({ version: 1, albums })), "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, this.#path);
    await chmod(this.#path, 0o600);
  }

  async list(): Promise<RecentAlbumRecord[]> {
    await this.#tail;
    return this.#read();
  }

  async resolve(id: string): Promise<RecentAlbumRecord | undefined> {
    return (await this.list()).find((album) => album.id === id);
  }

  async remove(id: string): Promise<void> {
    await this.#tail;
    const existing = await this.#read();
    await this.#write(existing.filter((album) => album.id !== id));
  }

  async updateStats(id: string, photoCount: number, ratedCount: number): Promise<void> {
    await this.#tail;
    const existing = await this.#read();
    const updated = existing.map((album) => album.id === id ? { ...album, photoCount, ratedCount, lastOpenedAt: new Date().toISOString() } : album);
    await this.#write(updated);
  }

  record(path: string): Promise<RecentAlbumRecord> {
    let result!: RecentAlbumRecord;
    const operation = this.#tail.then(async () => {
      const canonicalPath = await realpath(path);
      result = {
        id: createHash("sha256").update(canonicalPath).digest("hex"),
        name: basename(canonicalPath) || "本地相册",
        canonicalPath,
        lastOpenedAt: new Date().toISOString(),
        photoCount: 0,
        ratedCount: 0,
      };
      const existing = await this.#read();
      await this.#write([result, ...existing.filter((album) => album.id !== result.id)]);
    });
    this.#tail = operation.catch(() => undefined);
    return operation.then(() => result);
  }
}
