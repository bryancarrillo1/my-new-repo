import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { ChaosSettings, SystemView, WorkerView } from "@vpp/core/domain";
import { api } from "../lib/api.ts";
import { formatDuration } from "../lib/pipeline.ts";
import { usePolling } from "../hooks/useLiveQuery.ts";
import { Badge, Spinner, cx } from "../components/ui.tsx";
import styles from "./SystemPage.module.css";

const POLL_MS = 1000;

export function SystemPage() {
  const { data, error, refetch } = usePolling(api.getSystem, POLL_MS);

  if (error && !data) return <p className={styles.error}>Couldn't load system state: {error.message}</p>;
  if (!data) return <Spinner />;

  return (
    <section className={styles.page}>
      <header className={styles.head}>
        <div>
          <h1>System</h1>
          <p className="muted">
            Workers, queues and fault injection. Break things here, then watch a video's pipeline recover.
          </p>
        </div>
        <ChaosSummary chaos={data.chaos} />
      </header>

      <Stats system={data} onChange={refetch} />

      <div className={styles.columns}>
        <Workers workers={data.workers} onChange={refetch} />
        <FaultInjection chaos={data.chaos} onChange={refetch} />
      </div>
    </section>
  );
}

function ChaosSummary({ chaos }: { chaos: ChaosSettings }) {
  const active = [
    chaos.failureRate > 0 && `${Math.round(chaos.failureRate * 100)}% failures`,
    chaos.permanentFailures && "permanent failures",
    chaos.slowFactor > 1 && `${chaos.slowFactor}× slow`,
    chaos.dispatcherPaused && "dispatcher paused",
    chaos.crashNext > 0 && `${chaos.crashNext} crash armed`,
  ].filter(Boolean);
  return active.length ? (
    <Badge tone="warning" pulse>{`Chaos: ${active.join(" · ")}`}</Badge>
  ) : (
    <Badge tone="success">All systems normal</Badge>
  );
}

// ---------------------------------------------------------------------------

function Stats({ system, onChange }: { system: SystemView; onChange: () => void }) {
  const [redriving, setRedriving] = useState(false);
  const [redriveResult, setRedriveResult] = useState<string | null>(null);
  const { jobs, deadLetter } = system.queues;
  const dlq = deadLetter.visible + deadLetter.inFlight;

  async function redrive() {
    setRedriving(true);
    try {
      const r = await api.redriveDeadLetters();
      setRedriveResult(`Redrove ${r.redriven} of ${r.messages} message${r.messages === 1 ? "" : "s"}`);
      onChange();
    } finally {
      setRedriving(false);
    }
  }

  return (
    <div className={styles.stats}>
      <Stat
        label="Outbox backlog"
        value={system.outboxBacklog}
        hint="Committed jobs not yet sent to the queue"
        tone={system.chaos.dispatcherPaused && system.outboxBacklog > 0 ? "warning" : undefined}
      />
      <Stat label="Job queue" value={jobs.visible} hint={`${jobs.inFlight} in flight (received, not acked)`} />
      <Stat label="Dead-letter queue" value={dlq} hint="Failed after all retries, or permanently" tone={dlq ? "danger" : undefined}>
        <button className="btn" disabled={!dlq || redriving} onClick={() => void redrive()}>
          {redriving ? "Redriving…" : "Redrive all"}
        </button>
        {redriveResult && <span className={styles.statNote}>{redriveResult}</span>}
      </Stat>
      <Stat
        label="Jobs"
        value={system.jobsByState.running}
        hint={`running · ${system.jobsByState.pending} pending · ${system.jobsByState.completed} done · ${system.jobsByState.failed} failed`}
      />
    </div>
  );
}

function Stat(props: {
  label: string;
  value: number;
  hint: string;
  tone?: "warning" | "danger" | undefined;
  children?: ReactNode;
}) {
  return (
    <div className={cx("card", styles.stat, props.tone && styles[`stat_${props.tone}`])}>
      <div className={styles.statLabel}>{props.label}</div>
      <div className={styles.statValue}>{props.value}</div>
      <div className={styles.statHint}>{props.hint}</div>
      {props.children && <div className={styles.statActions}>{props.children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Workers({ workers, onChange }: { workers: WorkerView[]; onChange: () => void }) {
  return (
    <section className={cx("card", styles.panel)}>
      <div className={styles.panelHead}>
        <h2>Workers</h2>
        <span className="muted">{workers.filter((w) => w.alive).length} alive</span>
      </div>
      {workers.length === 0 ? (
        <p className="muted">No workers running. Start them with <code>npm run dev</code>.</p>
      ) : (
        <ul className={styles.workers}>
          {workers.map((w) => (
            <WorkerRow key={w.workerId} worker={w} onChange={onChange} />
          ))}
        </ul>
      )}
      <p className={styles.footnote}>
        <strong>Kill</strong> makes the worker exit immediately mid-job, like <code>kill -9</code>: no lease release,
        no acknowledgement. Its lease expires, another worker reclaims the job, and the supervisor restarts the
        process with a new PID.
      </p>
    </section>
  );
}

function WorkerRow({ worker: w, onChange }: { worker: WorkerView; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const silentFor = Date.now() - new Date(w.lastSeenAt).getTime();
  const status = !w.alive ? "dead" : w.killRequested ? "killing" : w.currentJob ? "busy" : "idle";

  async function kill() {
    setBusy(true);
    await api.killWorker(w.workerId).finally(() => setBusy(false));
    onChange();
  }

  return (
    <li className={cx(styles.worker, !w.alive && styles.workerDead)}>
      <span className={cx(styles.workerDot, styles[`dot_${status}`])} title={status} />
      <div className={styles.workerMain}>
        <div className={styles.workerTitle}>
          <span className="mono">pid {w.pid}</span>
          <span className={styles.workerHost}>{w.hostname}</span>
        </div>
        <div className={styles.workerJob}>
          {!w.alive ? (
            `no heartbeat for ${formatDuration(silentFor)}, presumed dead`
          ) : w.currentJob ? (
            <>
              {w.currentJob.label} ·{" "}
              <Link to={`/videos/${w.currentJob.videoId}`} className={styles.link}>
                {w.currentJob.videoTitle}
              </Link>
            </>
          ) : (
            "idle, waiting for messages"
          )}
        </div>
      </div>
      <button
        className={cx("btn", styles.killBtn)}
        disabled={!w.alive || w.killRequested || busy}
        onClick={() => void kill()}
      >
        {w.killRequested ? "Killing…" : "Kill"}
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------

function FaultInjection({ chaos: polled, onChange }: { chaos: ChaosSettings; onChange: () => void }) {
  // Optimistic UI: a control shows its new value immediately and keeps it
  // until the server's polled state agrees. Without this, a toggle snaps back
  // for up to a poll interval after each click.
  const [optimistic, setOptimistic] = useState<Partial<ChaosSettings>>({});
  const chaos: ChaosSettings = { ...polled, ...optimistic };
  useEffect(() => {
    setOptimistic((o) => {
      const stillPending = Object.entries(o).filter(([k, v]) => polled[k as keyof ChaosSettings] !== v);
      return stillPending.length === Object.keys(o).length ? o : Object.fromEntries(stillPending);
    });
  }, [polled]);

  // The slider keeps a local value while dragging and saves on release, so
  // the poll doesn't fight the user's thumb.
  const [rate, setRate] = useState(Math.round(chaos.failureRate * 100));
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) setRate(Math.round(chaos.failureRate * 100));
  }, [chaos.failureRate, dragging]);

  const update = async (patch: Partial<ChaosSettings>) => {
    setOptimistic((o) => ({ ...o, ...patch }));
    try {
      await api.updateChaos(patch);
    } catch (err) {
      // Roll back: drop our guess and let the server's state show through.
      setOptimistic((o) => Object.fromEntries(Object.entries(o).filter(([k]) => !(k in patch))));
      console.error("Couldn't update chaos settings", err);
    }
    onChange();
  };

  return (
    <section className={cx("card", styles.panel)}>
      <div className={styles.panelHead}>
        <h2>Fault injection</h2>
        <button
          className="btn btn-ghost"
          onClick={() => {
            setOptimistic({});
            void api.resetChaos().then(onChange);
          }}
        >
          Reset all
        </button>
      </div>

      <div className={styles.control}>
        <div className={styles.controlHead}>
          <label htmlFor="rate">Transient failure rate</label>
          <span className={cx("mono", styles.controlValue)}>{rate}%</span>
        </div>
        <input
          id="rate"
          type="range"
          min={0}
          max={100}
          step={5}
          value={rate}
          className={styles.slider}
          onPointerDown={() => setDragging(true)}
          onChange={(e) => setRate(Number(e.target.value))}
          onPointerUp={() => {
            setDragging(false);
            void update({ failureRate: rate / 100 });
          }}
          onKeyUp={() => void update({ failureRate: rate / 100 })}
        />
        <p className={styles.explain}>
          Jobs fail just before committing. Each failure is retried with exponential backoff and jitter; after 4
          attempts the job goes to the dead-letter queue.
        </p>
      </div>

      <Toggle
        label="Permanent failures"
        checked={chaos.permanentFailures}
        onChange={(v) => void update({ permanentFailures: v })}
        explain="Every job fails with “unsupported codec”. Permanent errors skip retries and are dead-lettered at once."
      />

      <Toggle
        label="Pause dispatcher"
        checked={chaos.dispatcherPaused}
        onChange={(v) => void update({ dispatcherPaused: v })}
        explain="Simulates a dispatcher outage. Uploads still succeed (the job and its outbox row commit together), and the outbox backlog drains when it resumes."
      />

      <div className={styles.control}>
        <div className={styles.controlHead}>
          <span>Slow mode</span>
          <div className={styles.segmented} role="group" aria-label="Slow mode">
            {[1, 3, 5].map((f) => (
              <button
                key={f}
                className={cx(styles.segment, chaos.slowFactor === f && styles.segmentOn)}
                onClick={() => void update({ slowFactor: f })}
              >
                {f}×
              </button>
            ))}
          </div>
        </div>
        <p className={styles.explain}>Stretches every job, leaving time to kill workers mid-job.</p>
      </div>

      <div className={styles.control}>
        <div className={styles.controlHead}>
          <span>Crash before commit</span>
          <button className="btn" onClick={() => void update({ crashNext: chaos.crashNext + 1 })}>
            {chaos.crashNext ? `Armed ×${chaos.crashNext}. Add one` : "Arm one crash"}
          </button>
        </div>
        <p className={styles.explain}>
          The next job's worker dies after doing the work but before recording it: “output saved, database not
          updated”. The reconciler expires the lease and the job is redone; nothing is lost or double-counted.
        </p>
      </div>
    </section>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (v: boolean) => void; explain: string }) {
  return (
    <div className={styles.control}>
      <label className={styles.controlHead}>
        <span>{props.label}</span>
        <input
          type="checkbox"
          role="switch"
          className={styles.switch}
          checked={props.checked}
          onChange={(e) => props.onChange(e.target.checked)}
        />
      </label>
      <p className={styles.explain}>{props.explain}</p>
    </div>
  );
}
