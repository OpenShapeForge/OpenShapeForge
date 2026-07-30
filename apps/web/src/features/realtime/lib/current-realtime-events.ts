// SPDX-License-Identifier: BUSL-1.1
import type { RealtimeResourceKey } from "@/features/realtime/lib/resource-keys";
import { isRecord } from "@/lib/json-record";

export type RealtimeChangedEvent = {
  type: "resource.changed";
  resourceType: string;
  resourceId?: string;
  scope?: string;
  sequence?: string;
  changedAt: string;
};

export type RealtimeDeletedEvent = {
  type: "resource.deleted";
  resourceType: string;
  resourceId?: string;
  scope?: string;
  sequence?: string;
  changedAt: string;
};

export type CurrentRealtimeEvent = RealtimeChangedEvent | RealtimeDeletedEvent;
export type RealtimeInvalidationKey =
  | RealtimeResourceKey
  | `entity-list:${string}:*`
  | "workflow-instance-list:*"
  | "workflow-definition-list:*"
  | `summary:${string}:current`
  | `collection:${string}:current`;

function parseJson(rawData: string): unknown | null {
  try {
    return JSON.parse(rawData) as unknown;
  } catch {
    return null;
  }
}

function isRealtimeEventType(value: unknown): value is CurrentRealtimeEvent["type"] {
  return value === "resource.changed" || value === "resource.deleted";
}

function isCurrentRealtimeEvent(value: unknown): value is CurrentRealtimeEvent {
  if (!isRecord(value) || !isRealtimeEventType(value.type)) {
    return false;
  }

  return (
    typeof value.resourceType === "string"
    && typeof value.changedAt === "string"
    && (value.resourceId === undefined || typeof value.resourceId === "string")
    && (value.scope === undefined || typeof value.scope === "string")
    && (value.sequence === undefined || typeof value.sequence === "string")
  );
}

export function parseCurrentRealtimeEvent(
  rawData: string,
  eventName: string,
): CurrentRealtimeEvent | null {
  const parsed = parseJson(rawData);
  if (!parsed || !isCurrentRealtimeEvent(parsed)) {
    return null;
  }

  return parsed.type === eventName ? parsed : null;
}

export function resourceKeysForCurrentRealtimeEvent(
  event: CurrentRealtimeEvent,
): RealtimeInvalidationKey[] {
  if (event.resourceType === "workflow.instance" && event.resourceId) {
    return [`workflow-instance:${event.resourceId}`, "workflow-instance-list:*"];
  }

  if (event.resourceType === "workflow.instance.list") {
    return event.scope ? [`workflow-instance-list:${event.scope}`] : [];
  }

  if (event.resourceType === "notification" && event.resourceId) {
    return [`notification:${event.resourceId}`];
  }

  if (
    event.resourceType === "notification.inbox"
    && event.scope?.startsWith("user:")
  ) {
    const userId = event.scope.slice("user:".length);
    return [
      `notification-inbox:${userId}`,
      `notification-recent:${userId}`,
    ];
  }

  if (event.resourceType.startsWith("entity.") && event.resourceId) {
    const entityType = event.resourceType.slice("entity.".length);
    return [
      `entity:${entityType}:${event.resourceId}`,
      `entity-list:${entityType}:*`,
    ];
  }

  if (event.resourceType.startsWith("entity.")) {
    return [`entity-list:${event.resourceType.slice("entity.".length)}:*`];
  }

  if (
    event.resourceType === "conversation"
    && event.resourceId
    && event.scope?.startsWith("tenant:")
  ) {
    // Detail-only. Inbox list/counter refreshes come from the coalesced
    // realtime.summary / realtime.collection invalidations below.
    return [`conversation:${event.resourceId}`];
  }

  if (
    (event.resourceType === "realtime.summary"
      || event.resourceType === "realtime.collection")
    && event.resourceId
    && event.scope?.startsWith("tenant:")
  ) {
    const kind = event.resourceType === "realtime.summary" ? "summary" : "collection";
    return [`${kind}:${event.resourceId}:current`];
  }

  if (event.resourceType === "workflow.definition.lock" && event.resourceId) {
    return [`workflow-definition-lock:${event.resourceId}`];
  }

  if (event.resourceType === "workflow.definition.version" && event.resourceId) {
    return [`workflow-definition-version:${event.resourceId}`];
  }

  if (event.resourceType === "workflow.definitions.catalog") {
    return ["workflow-definition-list:*"];
  }

  return [];
}
