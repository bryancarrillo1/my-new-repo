import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PipelineEvent } from "@vpp/core/domain";

type Listener = (e: PipelineEvent) => void;

interface EventsContextValue {
  connected: boolean;
  subscribe: (listener: Listener) => () => void;
}

const EventsContext = createContext<EventsContextValue | null>(null);

/** Sent to every listener when the stream (re)connects: "you may have missed events; refetch". */
export const RECONNECTED: PipelineEvent = { videoId: "*", ownerId: "", type: "reconnected", jobId: null };

/**
 * Opens ONE EventSource for the whole app and fans events out to components.
 * EventSource reconnects by itself after drops; on every (re)connect we tell
 * subscribers to refetch, because events are hints and some may have been
 * missed while disconnected. The database is the truth, not the stream.
 */
export function EventsProvider({ children }: { children: ReactNode }) {
  // useRef holds a mutable value that survives re-renders without causing them,
  // which is right for a listener registry.
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource("/api/events");
    const broadcast = (e: PipelineEvent) => listeners.current.forEach((l) => l(e));
    source.onopen = () => {
      setConnected(true);
      broadcast(RECONNECTED);
    };
    source.onerror = () => setConnected(false);
    source.onmessage = (msg) => broadcast(JSON.parse(msg.data) as PipelineEvent);
    // The cleanup function runs on unmount (≈ a context manager's __exit__).
    return () => source.close();
  }, []);

  // Stable identity across renders, so consumers don't resubscribe whenever
  // `connected` flips.
  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const value = useMemo(() => ({ connected, subscribe }), [connected, subscribe]);
  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>;
}

export function useEvents(): EventsContextValue {
  const ctx = useContext(EventsContext);
  if (!ctx) throw new Error("useEvents must be used inside <EventsProvider>");
  return ctx;
}
