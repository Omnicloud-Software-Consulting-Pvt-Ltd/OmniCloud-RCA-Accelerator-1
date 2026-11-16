import fs from "node:fs/promises";
import path from "node:path";
import type { AuditEvent, LifecycleTransaction } from "../types";
import { withBillingStep } from "../plan";

/**
 * Asset-lifecycle persistence — server-side JSON per Salesforce org: transactions (amendments / renewals / cancellations), their step
 * checkpoints and the audit trail, under ASSET_LIFECYCLE_DATA_DIR (default <app>/.data/asset-lifecycle). Atomic writes, serialized
 * per org. Salesforce stays the source of truth for quotes / orders / assets — this keeps the plan, progress and who did what.
 */
export interface LifecycleData { version: 1; orgId: string; transactions: LifecycleTransaction[]; audit: AuditEvent[] }
const MAX_AUDIT = 10_000;

export class LifecycleStore {
  private queue = new Map<string, Promise<unknown>>();
  constructor(readonly dir: string = process.env.ASSET_LIFECYCLE_DATA_DIR || path.join(process.cwd(), ".data", "asset-lifecycle")) {}

  durability() {
    const serverless = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
    const durable = !serverless || !!process.env.ASSET_LIFECYCLE_DATA_DIR;
    return { location: this.dir, durable, warning: durable ? null : "This deployment's disk is ephemeral: lifecycle progress and the app's audit trail last only until the instance is recycled. Set ASSET_LIFECYCLE_DATA_DIR to persistent storage. Salesforce records are unaffected." };
  }

  private file(orgId: string) {
    if (!/^[a-zA-Z0-9]{15,18}$/.test(orgId)) throw new Error("Invalid Salesforce org Id for lifecycle storage.");
    return path.join(this.dir, `${orgId.slice(0, 15)}.json`);
  }

  async load(orgId: string): Promise<LifecycleData> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file(orgId), "utf8")) as LifecycleData;
      if (raw?.version === 1) return { ...raw, transactions: (raw.transactions ?? []).map(withBillingStep), audit: raw.audit ?? [] };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Lifecycle storage couldn't be read (${(e as Error).message}).`);
    }
    return { version: 1, orgId, transactions: [], audit: [] };
  }

  async update<T>(orgId: string, fn: (d: LifecycleData) => T): Promise<T> {
    const key = this.file(orgId);
    const run = (this.queue.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const data = await this.load(orgId);
      const out = fn(data);
      if (data.audit.length > MAX_AUDIT) data.audit = data.audit.slice(-MAX_AUDIT);
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = `${key}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data), "utf8");
      await fs.rename(tmp, key);
      return out;
    });
    this.queue.set(key, run);
    try { return await run; } finally { if (this.queue.get(key) === run) this.queue.delete(key); }
  }
}

let shared: LifecycleStore | null = null;
export const lifecycleStore = () => (shared ??= new LifecycleStore());
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
