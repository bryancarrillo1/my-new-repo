import { useState, type FormEvent } from "react";
import { ApiError } from "../lib/api.ts";
import { useSession } from "../hooks/session.tsx";
import styles from "./LoginPage.module.css";

export function LoginPage() {
  const { login } = useSession();
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim());
    } catch (err) {
      setError(err instanceof ApiError && err.status === 400 ? "Use 2–32 letters, digits, _ or -." : "Login failed.");
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <form className={`card ${styles.card}`} onSubmit={onSubmit}>
        <div className={styles.logo}>
          <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M4 2.5v11l9-5.5z" />
          </svg>
        </div>
        <h1>Video Processing Pipeline</h1>
        <p className="muted">
          Upload → process → watch. A system-design demo with a transactional outbox, queue workers with
          fenced leases, and live pipeline events.
        </p>

        <label className={styles.label} htmlFor="username">
          Pick a username
        </label>
        <input
          id="username"
          className="input"
          autoFocus
          autoComplete="username"
          placeholder="e.g. alice"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        {error && <p className={styles.error}>{error}</p>}
        <button className="btn btn-primary" disabled={busy || username.trim().length < 2}>
          {busy ? "Signing in…" : "Continue"}
        </button>
        <p className={styles.hint}>Demo login, no password. Your videos are scoped to this name.</p>
      </form>
    </div>
  );
}
