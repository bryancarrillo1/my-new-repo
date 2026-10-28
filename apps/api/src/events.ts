import { EventEmitter } from "node:events";
import pg from "pg";
import { PIPELINE_CHANNEL, config, type PipelineEvent } from "@vpp/core";

/**
 * Bridges Postgres NOTIFY to in-process subscribers (SSE connections).
 *
 * One dedicated connection LISTENs for the whole API process, no matter how
 * many browsers are connected. If the connection drops we reconnect; anything
 * missed meanwhile is harmless because events are only "go refetch" hints and
 * the UI also refetches when its stream reconnects.
 */
export class EventHub {
  private readonly emitter = new EventEmitter();
  private client: pg.Client | null = null;
  private closed = false;

  constructor() {
    // Each SSE connection adds a listener; lift Node's default warning limit of 10.
    this.emitter.setMaxListeners(0);
  }

  async start(): Promise<void> {
    if (this.closed) return;
    const client = new pg.Client({ connectionString: config.DATABASE_URL });
    client.on("notification", (msg) => {
      if (msg.channel !== PIPELINE_CHANNEL || !msg.payload) return;
      this.emitter.emit("event", JSON.parse(msg.payload) as PipelineEvent);
    });
    client.on("error", () => this.reconnect());
    await client.connect();
    await client.query(`LISTEN ${PIPELINE_CHANNEL}`);
    this.client = client;
  }

  private reconnect(): void {
    this.client?.end().catch(() => {});
    this.client = null;
    if (this.closed) return;
    setTimeout(() => this.start().catch(() => this.reconnect()), 1000);
  }

  /** Returns an unsubscribe function (a common JS idiom in place of a context manager). */
  subscribe(listener: (e: PipelineEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client?.end();
  }
}
