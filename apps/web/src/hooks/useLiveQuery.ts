import { useCallback, useEffect, useRef, useState } from "react";
import type { PipelineEvent } from "@vpp/core/domain";
import { useEvents } from "./events.tsx";

export interface QueryState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
}

/** Bursts of events (e.g. progress ticks from 3 jobs) collapse into one refetch per window. */
const COALESCE_MS = 150;

/**
 * Fetches `load()` when `key` changes, then refetches whenever a pipeline event
 * matching `matches` arrives. A tiny, purpose-built version of what libraries
 * like TanStack Query do.
 *
 * Two subtleties handled here:
 *  - Out-of-order responses: each fetch gets a sequence number and only the
 *    latest one may update state, so a slow old response can't overwrite a
 *    newer one.
 *  - Event storms: refetches are coalesced into at most one per COALESCE_MS.
 */
export function useLiveQuery<T>(
  key: string,
  load: () => Promise<T>,
  matches: (e: PipelineEvent) => boolean,
): QueryState<T> & { refetch: () => void } {
  const [state, setState] = useState<QueryState<T>>({ data: undefined, error: undefined, loading: true });
  const { subscribe } = useEvents();

  // Keep the latest callbacks in refs so the effects below don't re-subscribe
  // on every render (inline arrow functions are new objects each render).
  const loadRef = useRef(load);
  const matchesRef = useRef(matches);
  loadRef.current = load;
  matchesRef.current = matches;

  const seq = useRef(0);
  const refetch = useCallback(() => {
    const mine = ++seq.current;
    loadRef.current().then(
      (data) => mine === seq.current && setState({ data, error: undefined, loading: false }),
      (error: Error) => mine === seq.current && setState((s) => ({ ...s, error, loading: false })),
    );
  }, []);

  // Initial load, and reload when the key (e.g. the videoId in the URL) changes.
  useEffect(() => {
    setState({ data: undefined, error: undefined, loading: true });
    refetch();
  }, [key, refetch]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe((event) => {
      if (event.videoId !== "*" && !matchesRef.current(event)) return;
      timer ??= setTimeout(() => {
        timer = undefined;
        refetch();
      }, COALESCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [subscribe, refetch]);

  return { ...state, refetch };
}

/** Re-renders every `intervalMs` while `active`, for live "elapsed" clocks. */
export function useNow(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/**
 * Fetches `load()` every `intervalMs`. For system-wide numbers (queue depths,
 * worker heartbeats) that change continuously and aren't tied to one video's
 * events. Skips ticks while a request is still in flight, and while the tab
 * is hidden.
 */
export function usePolling<T>(load: () => Promise<T>, intervalMs: number): QueryState<T> & { refetch: () => void } {
  const [state, setState] = useState<QueryState<T>>({ data: undefined, error: undefined, loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;
  const inFlight = useRef(false);

  const refetch = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    loadRef
      .current()
      .then(
        (data) => setState({ data, error: undefined, loading: false }),
        (error: Error) => setState((s) => ({ ...s, error, loading: false })),
      )
      .finally(() => {
        inFlight.current = false;
      });
  }, []);

  useEffect(() => {
    refetch();
    const id = setInterval(() => document.visibilityState === "visible" && refetch(), intervalMs);
    return () => clearInterval(id);
  }, [refetch, intervalMs]);

  return { ...state, refetch };
}
