import fs from "node:fs/promises";
import path from "node:path";
import type { HistoryEvent, RampDealDraft, RampExecution, RampSchedule } from "@/lib/ramp/types";

/**
 * RAMP persistence — SERVER-SIDE, never browser storage. The app had no database, so RAMP adds a small durable store:
 * one JSON document per Salesforce org (schedules, deals, executions, history) under RAMP_DATA_DIR (default <app>/.data/ramp).
 *  · Writes are atomic (write a temp file, then rename) and serialized per org, so concurrent requests never interleave or corrupt.
 *  · It survives browser refreshes and app restarts wherever the app's disk persists (local / `next start` / a VM / a container
 *    volume). On a serverless host whose disk is ephemeral (Vercel without RAMP_DATA_DIR on a persistent mount) it is NOT durable —
 *    `durability()` says so and the UI shows it; set RAMP_DATA_DIR to persistent storage (or replace this backend) there.
 * Every record carries the Salesforce org Id it belongs to and who created it; Salesforce itself stays the source of truth for
 * what was created there (every execution re-reads Salesforce before writing).
 */

export interface RampData { version: 1; orgId: string; schedules: RampSchedule[]; deals: RampDealDraft[]; executions: RampExecution[]; history: HistoryEvent[] }
const MAX_HISTORY = 10_000;

export interface Durability { backend: "file"; location: string; durable: boolean; warning: string | null }

export class RampStore {
  private queue = new Map<string, Promise<unknown>>();
  constructor(readonly dir: string = process.env.RAMP_DATA_DIR || path.join(process.cwd(), ".data", "ramp")) {}

  durability(): Durability {
    const serverless = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
    const configured = !!process.env.RAMP_DATA_DIR;
    const durable = !serverless || configured;
    return { backend: "file", location: this.dir, durable, warning: durable ? null : "This deployment's disk is ephemeral (serverless): RAMP history and execution checkpoints are kept only until the server instance is recycled. Set RAMP_DATA_DIR to persistent storage. Salesforce records themselves are unaffected." };
  }

  private file(orgId: string) {
    if (!/^[a-zA-Z0-9]{15,18}$/.test(orgId)) throw new Error("Invalid Salesforce org Id for RAMP storage.");
    return path.join(this.dir, `${orgId.slice(0, 15)}.json`);
  }

  async load(orgId: string): Promise<RampData> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file(orgId), "utf8")) as RampData;
      if (raw && raw.version === 1) return { ...raw, schedules: raw.schedules ?? [], deals: raw.deals ?? [], executions: raw.executions ?? [], history: raw.history ?? [] };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`RAMP storage couldn't be read (${(e as Error).message}).`);
    }
    return { version: 1, orgId, schedules: [], deals: [], executions: [], history: [] };
  }

  /** Read-modify-write, serialized per org and written atomically. `fn` returns the value to hand back. */
  async update<T>(orgId: string, fn: (d: RampData) => T): Promise<T> {
    const key = this.file(orgId);
    const prev = this.queue.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      const data = await this.load(orgId);
      const out = fn(data);
      if (data.history.length > MAX_HISTORY) data.history = data.history.slice(-MAX_HISTORY);
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

let shared: RampStore | null = null;
export const rampStore = () => (shared ??= new RampStore());

export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export function historyEvent(e: Omit<HistoryEvent, "id" | "at">, at = new Date().toISOString()): HistoryEvent {
  return { ...e, id: newId("h"), at };
}
