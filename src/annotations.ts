import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const coordinate = z.number().finite();
export const annotationDraftSchema = z.object({
  comment: z.string().trim().min(1).max(10_000),
  selector: z.string().max(4_000).nullable(),
  textSnippet: z.string().max(10_000).transform((text) => text.trim().slice(0, 200)),
  rect: z.object({ x: coordinate, y: coordinate, width: coordinate.nonnegative(), height: coordinate.nonnegative() }),
  viewport: z.object({ width: coordinate.positive(), height: coordinate.positive(), devicePixelRatio: coordinate.positive() }),
  scroll: z.object({ x: coordinate, y: coordinate }),
  anchorOffset: z.object({ x: coordinate, y: coordinate }).optional(),
  url: z.string().url().max(16_000).refine((url) => /^https?:\/\//i.test(url), "Annotations require an HTTP(S) URL"),
  title: z.string().max(4_000)
});
export const annotationStatusSchema = z.enum(["open", "resolved", "all"]);
export const annotationIdSchema = z.string().uuid();
export type AnnotationDraft = z.infer<typeof annotationDraftSchema>;
export type Annotation = AnnotationDraft & {
  id: string;
  createdAt: string;
  status: "open" | "resolved";
  resolvedAt?: string;
  resolutionNote?: string;
  screenshotPath: string;
};
export type AnnotationFilter = { url?: string; status?: "open" | "resolved" | "all" };

export function annotationDirectory(): string {
  return join(process.env.UBB_DATA_DIR ? resolve(process.env.UBB_DATA_DIR) : join(homedir(), ".universal-browser-bridge"), "annotations");
}

const savedAnnotationSchema = annotationDraftSchema.extend({
  id: annotationIdSchema,
  createdAt: z.string().datetime(),
  status: z.enum(["open", "resolved"]),
  resolvedAt: z.string().datetime().optional(),
  resolutionNote: z.string().max(10_000).optional(),
  screenshotPath: z.string()
});

// The daemon is the sole writer. Serialize mutations so concurrent saves and
// resolutions never overwrite one another, and publish state only after rename.
export class AnnotationStore {
  readonly directory: string;
  private records?: Annotation[];
  private writes: Promise<unknown> = Promise.resolve();

  constructor(directory = annotationDirectory()) {
    this.directory = resolve(directory);
  }

  private async load(): Promise<Annotation[]> {
    if (this.records) return this.records;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    try {
      const parsed = savedAnnotationSchema.array().parse(JSON.parse(await fs.readFile(join(this.directory, "annotations.json"), "utf8")));
      this.records = parsed.map((record) => ({ ...record, screenshotPath: join(this.directory, `${record.id}.png`) }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.records = [];
    }
    return this.records;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    this.writes = result.catch(() => {});
    return result;
  }

  private async atomicWrite(path: string, data: string | Buffer): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, path);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async create(draft: AnnotationDraft, screenshot: string): Promise<Annotation> {
    const data = annotationDraftSchema.parse(draft);
    const encoded = z.string().max(28_000_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/).parse(screenshot);
    const png = Buffer.from(encoded.slice("data:image/png;base64,".length), "base64");
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Screenshot must be a PNG");
    return this.mutate(async () => {
      const records = await this.load();
      const id = randomUUID();
      const record: Annotation = { ...data, id, createdAt: new Date().toISOString(), status: "open", screenshotPath: join(this.directory, `${id}.png`) };
      await this.atomicWrite(record.screenshotPath, png);
      const next = [...records, record];
      try {
        await this.atomicWrite(join(this.directory, "annotations.json"), JSON.stringify(next, null, 2) + "\n");
      } catch (error) {
        await fs.rm(record.screenshotPath, { force: true });
        throw error;
      }
      this.records = next;
      return structuredClone(record);
    });
  }

  async list(filter: AnnotationFilter = {}): Promise<Annotation[]> {
    const { url, status = "all" } = z.object({ url: z.string().optional(), status: annotationStatusSchema.optional() }).parse(filter);
    await this.writes;
    const records = await this.load();
    return structuredClone(records.filter((record) => (url === undefined || record.url === url) && (status === "all" || record.status === status)));
  }

  async get(id: string): Promise<Annotation> {
    annotationIdSchema.parse(id);
    const record = (await this.list()).find((record) => record.id === id);
    if (!record) throw new Error(`Annotation not found: ${id}`);
    return record;
  }

  async resolve(id: string, note?: string): Promise<Annotation> {
    annotationIdSchema.parse(id);
    z.string().max(10_000).optional().parse(note);
    return this.mutate(async () => {
      const records = await this.load();
      const record = records.find((record) => record.id === id);
      if (!record) throw new Error(`Annotation not found: ${id}`);
      if (record.status === "resolved") return structuredClone(record);
      const updated: Annotation = { ...record, status: "resolved", resolvedAt: new Date().toISOString(), ...(note === undefined ? {} : { resolutionNote: note }) };
      const next = records.map((item) => item.id === id ? updated : item);
      await this.atomicWrite(join(this.directory, "annotations.json"), JSON.stringify(next, null, 2) + "\n");
      this.records = next;
      return structuredClone(updated);
    });
  }
}
