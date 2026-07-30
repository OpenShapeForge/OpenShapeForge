// SPDX-License-Identifier: BUSL-1.1
export interface FieldChange {
  field: string;
  old: unknown;
  new: unknown;
}

export interface TimelineActor {
  type: "relatie" | "bron";
  displayName: string;
  firstName?: string;
  lastName?: string;
  roleLabel?: string;
  sourceLabel?: string;
  relationUri?: string;
  resolvedVia: "account" | "relatie" | "bron";
}

export interface TimelineEvent {
  id: string;
  titel: string;
  omschrijving: string | null;
  categorie: string;
  actie: string;
  bronDomein: string;
  bronEntiteitType: string;
  bronEntiteitId: string | null;
  entityUri: string;
  linkType: string;
  userId: string;
  actor?: TimelineActor;
  timestamp: string;
  metadata?: {
    fieldChanges?: FieldChange[];
  };
}

export interface TimelineResponse {
  events: TimelineEvent[];
  nextCursor: string | null;
  total: number;
}

export interface TimelineSummary {
  summary: string | null;
  eventCount: number;
  generatedAt: string | null;
  stale: boolean;
}
