// SPDX-License-Identifier: BUSL-1.1
export type RealtimeResourceKey =
  | `entity:${string}:${string}`
  | `entity-list:${string}:${string}`
  | `notification:${string}`
  | `notification-inbox:${string}`
  | `notification-recent:${string}`
  | `conversation:${string}`
  | "conversation-inbox:current"
  | `summary:${string}:current`
  | `collection:${string}:current`;

export function notificationInboxResourceKey(userId: string): RealtimeResourceKey {
  return `notification-inbox:${userId}`;
}

export function notificationRecentResourceKey(userId: string): RealtimeResourceKey {
  return `notification-recent:${userId}`;
}

export function conversationResourceKey(conversationId: string): RealtimeResourceKey {
  return `conversation:${conversationId}`;
}

export function conversationInboxResourceKey(): RealtimeResourceKey {
  return "conversation-inbox:current";
}

/** Per-(tenant,user) inbox counter summary; resolved server-side from session. */
export function conversationInboxSummaryResourceKey(): RealtimeResourceKey {
  return "summary:conversationInbox:current";
}

/** Tenant-scoped inbox list invalidation; drives paginated list refreshes. */
export function conversationInboxCollectionResourceKey(): RealtimeResourceKey {
  return "collection:conversationInbox:current";
}
