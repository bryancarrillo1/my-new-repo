import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";

export type Session =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; username: string };

interface SessionContextValue {
  session: Session;
  login: (username: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ status: "loading" });

  useEffect(() => {
    api.getSession().then(
      ({ username }) => setSession(username ? { status: "authenticated", username } : { status: "anonymous" }),
      (err: unknown) => {
        console.error("Couldn't check session", err);
        setSession({ status: "anonymous" });
      },
    );
  }, []);

  const value: SessionContextValue = {
    session,
    login: async (username) => {
      const res = await api.login(username);
      setSession({ status: "authenticated", username: res.username });
    },
    logout: async () => {
      await api.logout();
      setSession({ status: "anonymous" });
    },
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}
