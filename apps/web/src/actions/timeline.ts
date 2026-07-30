// SPDX-License-Identifier: BUSL-1.1
"use server";

import type { TimelineResponse, TimelineSummary } from "@/lib/timeline-types";
import { executeGraphqlRequest } from "@/lib/server/graphql-client";

type TimelineGraphqlResponse = {
  timeline?: {
    events?: Array<{
      id: string;
      title: string;
      description: string | null;
      category: string;
      action: string;
      sourceDomain: string;
      sourceEntityType: string;
      sourceEntityId: string | null;
      entityUri: string;
      linkType: string;
      actorUserId: string | null;
      occurredAt: string;
      fieldChanges: Array<{
        field: string;
        old: unknown;
        new: unknown;
      }>;
    }>;
    nextCursor: string | null;
    total: number;
  };
};

const TIMELINE_QUERY = /* GraphQL */ `
  query Timeline(
    $entityType: String!
    $entityId: ID!
    $cursor: String
    $limit: Int
    $category: String
    $action: String
    $domain: String
    $include: [TimelineIncludeInput!]
    $from: String
    $to: String
  ) {
    timeline(
      entityType: $entityType
      entityId: $entityId
      cursor: $cursor
      limit: $limit
      category: $category
      action: $action
      domain: $domain
      include: $include
      from: $from
      to: $to
    ) {
      events {
        id
        title
        description
        category
        action
        sourceDomain
        sourceEntityType
        sourceEntityId
        entityUri
        linkType
        actorUserId
        occurredAt
        fieldChanges {
          field
          old
          new
        }
      }
      nextCursor
      total
    }
  }
`;

function parsePlatformEntityUri(entityUri: string) {
  const match = entityUri.match(/^platform:([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Ongeldige tijdlijn-entiteit: ${entityUri}`);
  }
  return {
    entityType: match[1],
    entityId: decodeURIComponent(match[2]),
  };
}

export async function getTimelineEvents(
  entityUri: string,
  options?: {
    cursor?: string;
    limit?: number;
    categorie?: string;
    actie?: string;
    domein?: string;
    include?: readonly { relationship: string }[];
    from?: string;
    to?: string;
  },
): Promise<TimelineResponse> {
  const { entityType, entityId } = parsePlatformEntityUri(entityUri);
  const includeVariable = options?.include?.length
    ? options.include.map((entry) => ({ relationship: entry.relationship }))
    : null;
  const data = await executeGraphqlRequest<TimelineGraphqlResponse>({
    query: TIMELINE_QUERY,
    variables: {
      entityType,
      entityId,
      cursor: options?.cursor ?? null,
      limit: options?.limit ?? 20,
      category: options?.categorie || null,
      action: options?.actie || null,
      domain: options?.domein || null,
      include: includeVariable,
      from: options?.from ?? null,
      to: options?.to ?? null,
    },
    cache: "no-store",
  });

  const timeline = data.timeline;
  if (!timeline) {
    return { events: [], nextCursor: null, total: 0 };
  }

  return {
    events: (timeline.events ?? []).map((event) => ({
      id: event.id,
      titel: event.title,
      omschrijving: event.description,
      categorie: event.category,
      actie: event.action,
      bronDomein: event.sourceDomain,
      bronEntiteitType: event.sourceEntityType,
      bronEntiteitId: event.sourceEntityId,
      entityUri: event.entityUri,
      linkType: event.linkType,
      userId: event.actorUserId ?? "system",
      timestamp: event.occurredAt,
      metadata: {
        fieldChanges: event.fieldChanges,
      },
    })),
    nextCursor: timeline.nextCursor,
    total: timeline.total,
  };
}

export async function getTimelineSummary(
  entityUri: string,
): Promise<TimelineSummary> {
  void entityUri;
  return { summary: null, eventCount: 0, generatedAt: null, stale: false };
}
