import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { useRouterService } from './RouterContext';
import { deriveTopology } from './topology.ts';

import type { RouterData } from './routerStore';
import type { TopologyGraph, TopologyPeer } from './topology';

export const TOPOLOGY_THROTTLE_MS = 1500;
export const TOPOLOGY_CLOCK_MS = 30_000;

/**
 * `RouterStore.transaction` deep-clones and swaps `data` wholesale, so every sub-reference
 * changes on every committed mesh write and `MeshRouter.tick` runs at 1 Hz. Subscribing
 * directly would re-render this screen dozens of times a second. Leading edge plus a
 * trailing coalesce: the first change after idle lands immediately, then a burst collapses
 * into one update per interval.
 */
export function useThrottledRouterData(intervalMs = TOPOLOGY_THROTTLE_MS): RouterData {
  const router = useRouterService();
  const snapshot = useRef(router.store.data);

  const subscribe = useCallback(
    (onChange: () => void) => {
      let last = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        timer = undefined;
        last = Date.now();
        if (snapshot.current === router.store.data) return;
        // Mutate before notifying so getSnapshot never returns a value React has not seen.
        snapshot.current = router.store.data;
        onChange();
      };
      const unsubscribe = router.store.subscribe(() => {
        if (timer) return;
        const wait = Math.max(0, intervalMs - (Date.now() - last));
        if (wait === 0) flush();
        else timer = setTimeout(flush, wait);
      });
      // Catch a write that landed between the first render and this subscription.
      if (snapshot.current !== router.store.data) flush();
      return () => {
        if (timer) clearTimeout(timer);
        unsubscribe();
      };
    },
    [intervalMs, router],
  );

  return useSyncExternalStore(subscribe, () => snapshot.current, () => snapshot.current);
}

/**
 * A clock that only moves in coarse steps. Reading `Date.now()` inside the derivation
 * memo would make it recompute on every render and never hold.
 */
export function useCoarseNow(intervalMs = TOPOLOGY_CLOCK_MS) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / intervalMs) * intervalMs);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Math.floor(Date.now() / intervalMs) * intervalMs);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Hold the previous graph object whenever the new one is structurally identical. This is
 * what keeps node object identity stable, so the layout memo is a real cache hit and
 * `React.memo` on the node views short-circuits. Without it the graph would be re-laid
 * out — and visibly jitter — on every mesh write.
 */
export function useStableBySignature(graph: TopologyGraph): TopologyGraph {
  // Keyed on the signature alone, deliberately: when the structure is unchanged this
  // must hand back the *previous* object, not the equivalent new one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => graph, [graph.signature]);
}

export type UseTopologyOptions = {
  selfId: string;
  rootId?: string;
  peers: TopologyPeer[];
  maxDepth?: number;
  historyMs?: number;
  maxPerRing?: number;
};

export function useTopology(options: UseTopologyOptions): TopologyGraph {
  const { selfId, rootId, peers, maxDepth, historyMs, maxPerRing } = options;
  const data = useThrottledRouterData();
  const now = useCoarseNow();

  const graph = useMemo(
    () =>
      deriveTopology({
        selfId,
        rootId,
        now,
        maxDepth,
        historyMs,
        maxPerRing,
        peers,
        contacts: data.contacts,
        packets: data.packets,
        chat: data.chat,
        events: data.events,
      }),
    [data, historyMs, maxDepth, maxPerRing, now, peers, rootId, selfId],
  );

  return useStableBySignature(graph);
}
