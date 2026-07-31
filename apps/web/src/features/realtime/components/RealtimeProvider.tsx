// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAppSession } from "@/components/ui/layout/session-provider";
import {
  parseCurrentRealtimeEvent,
  resourceKeysForCurrentRealtimeEvent,
  type CurrentRealtimeEvent,
  type RealtimeInvalidationKey,
} from "@/features/realtime/lib/current-realtime-events";
import type { RealtimeResourceKey } from "@/features/realtime/lib/resource-keys";

export type RealtimeSubscriptionHandler = (event?: CurrentRealtimeEvent) => void;

type RealtimeContextValue = {
  subscribe: (
    resourceKey: RealtimeResourceKey,
    handler: RealtimeSubscriptionHandler,
  ) => () => void;
};

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export function rememberGraphqlRealtimeSequence(
  currentSequence: string | null,
  event: CurrentRealtimeEvent,
): string | null {
  return event.sequence ?? currentSequence;
}

function subscribeToMap(
  subscriptions: Map<RealtimeResourceKey, Set<RealtimeSubscriptionHandler>>,
  resourceKey: RealtimeResourceKey,
  handler: RealtimeSubscriptionHandler,
) {
  const existing = subscriptions.get(resourceKey);
  if (existing) {
    existing.add(handler);
    return;
  }

  subscriptions.set(resourceKey, new Set([handler]));
}

function unsubscribeFromMap(
  subscriptions: Map<RealtimeResourceKey, Set<RealtimeSubscriptionHandler>>,
  resourceKey: RealtimeResourceKey,
  handler: RealtimeSubscriptionHandler,
) {
  const existing = subscriptions.get(resourceKey);
  if (!existing) {
    return;
  }

  existing.delete(handler);
  if (existing.size === 0) {
    subscriptions.delete(resourceKey);
  }
}

/**
 * Derive GraphQL subscription resource filters from the active frontend keys.
 * List subscriptions are broadened to their canonical wildcard keys so one
 * server event can invalidate all filtered client lists of the same type.
 */
export function deriveGraphqlRealtimeResources(
  keys: Iterable<RealtimeResourceKey>,
): string[] {
  const set = new Set<string>();
  for (const key of keys) {
    if (key.startsWith("entity-list:")) {
      const [, entityType] = key.split(":");
      if (entityType) set.add(`entity-list:${entityType}:*`);
    } else if (key.startsWith("workflow-instance-list:")) {
      set.add("workflow-instance-list:all");
    } else {
      set.add(key);
    }
  }
  return Array.from(set).sort();
}

const REALTIME_EVENTS_SUBSCRIPTION = `
  subscription RealtimeEvents($resources: [String!], $afterSequence: String) {
    realtimeEvents(resources: $resources, afterSequence: $afterSequence) {
      type
      resourceType
      resourceId
      scope
      sequence
      changedAt
    }
  }
`;

export function buildGraphqlRealtimeUrl(
  resources: readonly string[],
  afterSequence?: string | null,
): string {
  const params = new URLSearchParams({
    query: REALTIME_EVENTS_SUBSCRIPTION,
    variables: JSON.stringify({
      resources,
      ...(afterSequence ? { afterSequence } : {}),
    }),
  });
  return `/api/graphql?${params.toString()}`;
}

function parseGraphqlRealtimeEvent(rawData: string): CurrentRealtimeEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawData) as unknown;
  } catch {
    return null;
  }

  const event =
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    payload.data &&
    typeof payload.data === "object" &&
    "realtimeEvents" in payload.data
      ? payload.data.realtimeEvents
      : null;

  if (!event || typeof event !== "object" || !("type" in event)) {
    return null;
  }

  const record = event as Record<string, unknown>;
  const normalized = {
    type: record.type,
    resourceType: record.resourceType,
    ...(typeof record.resourceId === "string" ? { resourceId: record.resourceId } : {}),
    ...(typeof record.scope === "string" ? { scope: record.scope } : {}),
    ...(typeof record.sequence === "string" ? { sequence: record.sequence } : {}),
    changedAt: record.changedAt,
  };

  return parseCurrentRealtimeEvent(JSON.stringify(normalized), String(record.type));
}

export function RealtimeProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const session = useAppSession();
  const subscriptionsRef = useRef(
    new Map<RealtimeResourceKey, Set<RealtimeSubscriptionHandler>>(),
  );
  const lastSequenceRef = useRef<string | null>(null);
  const [subscriptionCount, setSubscriptionCount] = useState(0);

  const upstreamResources = useMemo(() => {
    void subscriptionCount;
    return deriveGraphqlRealtimeResources(subscriptionsRef.current.keys());
  }, [subscriptionCount]);

  const upstreamResourcesKey = upstreamResources.join(",");

  const subscribe = useCallback<RealtimeContextValue["subscribe"]>((resourceKey, handler) => {
    subscribeToMap(subscriptionsRef.current, resourceKey, handler);
    setSubscriptionCount((current) => current + 1);

    return () => {
      unsubscribeFromMap(subscriptionsRef.current, resourceKey, handler);
      setSubscriptionCount((current) => Math.max(0, current - 1));
    };
  }, []);

  useEffect(() => {
    if (!enabled || !session || subscriptionCount === 0) {
      return;
    }

    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    function publishResourceKey(
      resourceKey: RealtimeInvalidationKey,
      event: CurrentRealtimeEvent,
    ) {
      if (resourceKey.endsWith(":*")) {
        const prefix = resourceKey.slice(0, -1);
        for (const [subscriptionKey, handlers] of subscriptionsRef.current.entries()) {
          if (!subscriptionKey.startsWith(prefix)) {
            continue;
          }

          for (const handler of handlers) {
            handler(event);
          }
        }
        return;
      }

      const handlers = subscriptionsRef.current.get(resourceKey);
      if (!handlers || handlers.size === 0) {
        return;
      }

      for (const handler of handlers) {
        handler(event);
      }
    }

    function handleMessage(eventName: string, rawData: string) {
      const parsed = parseCurrentRealtimeEvent(rawData, eventName);
      if (!parsed) {
        return;
      }

      for (const resourceKey of resourceKeysForCurrentRealtimeEvent(parsed)) {
        publishResourceKey(resourceKey, parsed);
      }
    }

    function connect() {
      if (destroyed) {
        return;
      }

      eventSource = new EventSource(
        buildGraphqlRealtimeUrl(upstreamResources, lastSequenceRef.current),
      );

      for (const eventName of ["resource.changed", "resource.deleted"] as const) {
        eventSource.addEventListener(eventName, (event: MessageEvent) => {
          handleMessage(eventName, String(event.data));
        });
      }

      eventSource.addEventListener("next", (event: MessageEvent) => {
        const parsed = parseGraphqlRealtimeEvent(String(event.data));
        if (!parsed) {
          return;
        }

        if (parsed.sequence) {
          lastSequenceRef.current = rememberGraphqlRealtimeSequence(
            lastSequenceRef.current,
            parsed,
          );
        }

        for (const resourceKey of resourceKeysForCurrentRealtimeEvent(parsed)) {
          publishResourceKey(resourceKey, parsed);
        }
      });

      eventSource.addEventListener("connected", () => {
        // The server emits an initial handshake event. We intentionally ignore it.
      });

      eventSource.onerror = () => {
        eventSource?.close();
        eventSource = null;

        if (!destroyed) {
          reconnectTimer = setTimeout(connect, 5_000);
        }
      };
    }

    connect();

    return () => {
      destroyed = true;
      eventSource?.close();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
    };
  }, [enabled, session, subscriptionCount, upstreamResources, upstreamResourcesKey]);

  const value = useMemo<RealtimeContextValue>(() => ({ subscribe }), [subscribe]);

  return (
    <RealtimeContext.Provider value={value}>
      {children}
    </RealtimeContext.Provider>
  );
}

export function useRealtimeContext() {
  const context = useContext(RealtimeContext);
  if (!context) {
    throw new Error("useRealtimeContext must be used within a RealtimeProvider.");
  }
  return context;
}
