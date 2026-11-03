import fs from 'node:fs/promises';
import path from 'node:path';

export interface OutboxEntry {
  id: string;
  payload: unknown;
  attempts: number;
  nextAt: number;
  createdAt: number;
}

/** Durable queue for submissions when the Worker is briefly unreachable. */
export class Outbox {
  private file: string;
  private entries: OutboxEntry[] = [];
  private loaded = false;
  private flushing = false;

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const text = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        this.entries = parsed.filter(
          (e) => e && typeof e.id === 'string' && typeof e.nextAt === 'number',
        );
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('outbox: could not read', this.file, (e as Error).message);
      }
    }
  }

  size(): number {
    return this.entries.length;
  }

  async add(payload: unknown): Promise<void> {
    await this.load();
    this.entries.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      payload,
      attempts: 0,
      nextAt: Date.now(),
      createdAt: Date.now(),
    });
    await this.save();
  }

  /** Retry due entries. `send` must throw on transient failure. */
  async flush(send: (payload: unknown) => Promise<void>): Promise<number> {
    await this.load();
    if (this.flushing) return 0;
    this.flushing = true;
    let sent = 0;
    try {
      const now = Date.now();
      const due = this.entries.filter((entry) => entry.nextAt <= now);
      for (const entry of due) {
        try {
          await send(entry.payload);
          this.entries = this.entries.filter((item) => item.id !== entry.id);
          sent++;
        } catch (e) {
          entry.attempts++;
          const backoff = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(entry.attempts, 6));
          entry.nextAt = Date.now() + backoff;
          console.warn(
            'outbox: retry failed',
            entry.id,
            `attempt ${entry.attempts}`,
            (e as Error).message,
          );
          if (entry.attempts >= 30) {
            this.entries = this.entries.filter((item) => item.id !== entry.id);
            console.error('outbox: dropping after 30 attempts', entry.id);
          }
        }
      }
      if (due.length) await this.save();
      return sent;
    } finally {
      this.flushing = false;
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.entries, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }
}

interface State {
  lastEventId: number;
}

export class StateStore {
  private file: string;
  private state: State = { lastEventId: 0 };
  private loaded = false;

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const text = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed && Number.isFinite(parsed.lastEventId)) {
        this.state.lastEventId = Number(parsed.lastEventId);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('state: could not read', this.file, (e as Error).message);
      }
    }
  }

  get lastEventId(): number {
    return this.state.lastEventId;
  }

  async setLastEventId(value: number): Promise<void> {
    if (value <= this.state.lastEventId) return;
    this.state.lastEventId = value;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }
}
