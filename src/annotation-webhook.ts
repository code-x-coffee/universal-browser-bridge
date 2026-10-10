import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { annotationDataRoot, type Annotation } from "./annotations.js";

const httpUrl = z.string().url().refine((url) => /^https?:\/\//i.test(url));
const configSchema = z.object({
  url: httpUrl,
  headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), z.string().regex(/^[\t\x20-\x7e\x80-\xff]*$/)).default({}),
  enabled: z.boolean().default(true)
});
type Config = z.infer<typeof configSchema>;
type Source = "file" | "env" | "none";
export type WebhookResult = { ok: boolean; attempts: number; status?: number; error?: string };
export type WebhookStatus = { configured: boolean; enabled: boolean; source: Source; host: string | null; headerNames: string[] };
type Options = {
  dataRoot?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: (message: string) => void;
  timeoutMs?: number;
  backoffMs?: readonly number[];
};

export class AnnotationWebhook {
  private readonly dataRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: (message: string) => void;
  private readonly timeoutMs: number;
  private readonly backoffMs: readonly number[];
  private warnedInvalid = false;

  constructor(options: Options = {}) {
    this.dataRoot = options.dataRoot ?? annotationDataRoot();
    this.env = options.env ?? process.env;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger ?? ((message) => process.stderr.write(message + "\n"));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.backoffMs = options.backoffMs ?? [1_000, 2_000, 4_000];
  }

  private log(message: string): void {
    try { this.logger(message); } catch { /* Logging must not affect delivery. */ }
  }

  private async config(): Promise<{ source: Source; config?: Config }> {
    const override = this.env.UBB_ANNOTATION_WEBHOOK_URL;
    const source: Source = override !== undefined ? "env" : "file";
    try {
      let file: Config | undefined;
      try {
        file = configSchema.parse(JSON.parse(await readFile(join(this.dataRoot, "webhook.json"), "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const config = override !== undefined
        ? { url: httpUrl.parse(override), headers: file?.headers ?? {}, enabled: true }
        : file;
      this.warnedInvalid = false;
      return { source: config ? source : "none", config };
    } catch {
      // Validation/read errors can contain URLs and credentials. Never print them.
      if (!this.warnedInvalid) this.log("Annotation webhook: invalid configuration; delivery disabled");
      this.warnedInvalid = true;
      return { source };
    }
  }

  async status(): Promise<WebhookStatus> {
    const { config, source } = await this.config();
    return {
      configured: config !== undefined, enabled: config?.enabled ?? false, source,
      host: config ? new URL(config.url).host : null,
      headerNames: config ? Object.keys(config.headers).sort() : []
    };
  }

  created(annotation: Annotation): Promise<WebhookResult> {
    const { id, comment, url, title, textSnippet, selector, createdAt, screenshotPath } = annotation;
    return this.send({ event: "annotation.created", annotation: { id, comment, url, title, textSnippet, selector, createdAt, screenshotPath } });
  }

  test(): Promise<WebhookResult> {
    return this.send({ event: "annotation.test", sentAt: new Date().toISOString() });
  }

  private async send(payload: unknown): Promise<WebhookResult> {
    const { config } = await this.config();
    if (!config?.enabled) return { ok: false, attempts: 0, error: config ? "Webhook is disabled" : "Webhook is not configured" };
    const host = new URL(config.url).host;
    const headers = new Headers(config.headers);
    headers.set("Content-Type", "application/json");
    if (!headers.has("User-Agent")) headers.set("User-Agent", "universal-browser-bridge");
    const body = JSON.stringify(payload);
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: WebhookResult;
      let retry: boolean;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("timeout"));
          }, this.timeoutMs);
        });
        // The deadline also bounds injected fetch implementations that ignore abort.
        const response = await Promise.race([
          this.fetch(config.url, { method: "POST", headers, body, signal: controller.signal, redirect: "manual" }),
          deadline
        ]);
        void response.body?.cancel().catch(() => {});
        result = { ok: response.ok, status: response.status, attempts: attempt + 1 };
        if (response.ok) return result;
        retry = response.status === 429 || response.status >= 500;
        this.log(`Annotation webhook ${host}: HTTP ${response.status}`);
      } catch {
        const error = controller.signal.aborted ? "timeout" : "network error";
        result = { ok: false, error, attempts: attempt + 1 };
        retry = true;
        this.log(`Annotation webhook ${host}: ${error}`);
      } finally {
        clearTimeout(timer);
      }
      const delay = this.backoffMs[attempt];
      if (!retry || delay === undefined) return result;
      await this.sleep(delay);
    }
  }
}
