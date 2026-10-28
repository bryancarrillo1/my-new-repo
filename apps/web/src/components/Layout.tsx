import { NavLink, Outlet } from "react-router";
import { useEvents } from "../hooks/events.tsx";
import { useSession } from "../hooks/session.tsx";
import { cx } from "./ui.tsx";
import styles from "./Layout.module.css";

export function Layout({ username }: { username: string }) {
  const { connected } = useEvents();
  const { logout } = useSession();
  const navClass = ({ isActive }: { isActive: boolean }) => cx(styles.navLink, isActive && styles.navActive);

  return (
    <>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <NavLink to="/" className={cx(styles.brand)}>
            <span className={styles.logo}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M4 2.5v11l9-5.5z" />
              </svg>
            </span>
            <span className={styles.brandText}>Pipeline</span>
          </NavLink>
          <nav className={styles.nav}>
            <NavLink to="/" end className={navClass}>
              Library
            </NavLink>
            <NavLink to="/upload" className={navClass}>
              Upload
            </NavLink>
          </nav>
          <div className={styles.spacer} />
          <div
            className={styles.live}
            title={connected ? "Receiving live pipeline events (SSE)" : "Event stream disconnected; reconnecting"}
          >
            <span className={cx(styles.dot, connected && styles.dotOn)} />
            <span className={styles.liveLabel}>{connected ? "Live" : "Reconnecting…"}</span>
          </div>
          <div className={styles.user}>
            <span className={styles.avatar}>{username.slice(0, 2)}</span>
            <span className={styles.username}>{username}</span>
            <button className={cx("btn btn-ghost", styles.logout)} onClick={() => void logout()}>
              Log out
            </button>
          </div>
        </div>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </>
  );
}
