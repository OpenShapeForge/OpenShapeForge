// SPDX-License-Identifier: BUSL-1.1
import { isOperationAcceptance, type OperationAcceptance } from "@/lib/operation-acceptance";

const ENTITY_DELETE_ENDPOINT = "/api/entity/delete";

type EntityDeletePayload = {
  accepted?: unknown;
  errors?: { message?: string }[];
  message?: string;
};

function extractDeleteError(payload: EntityDeletePayload | null, fallback: string): string {
  if (typeof payload?.errors?.[0]?.message === "string" && payload.errors[0].message.trim()) {
    return payload.errors[0].message;
  }

  if (typeof payload?.message === "string" && payload.message.trim()) {
    return payload.message;
  }

  return fallback;
}

export async function deleteEntity(options: {
  mutationName: string;
  entityId: string;
  expectedVersion: string;
  confirmed: true;
}): Promise<{ deleted: true } | { accepted: OperationAcceptance }> {
  const response = await fetch(ENTITY_DELETE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mutationName: options.mutationName,
      id: options.entityId,
      expectedVersion: options.expectedVersion,
      confirmed: options.confirmed,
    }),
  });

  const payload = await response.json().catch(() => null) as EntityDeletePayload | null;
  // 202: an operation override took the delete; the record still exists.
  if (response.status === 202 && isOperationAcceptance(payload?.accepted)) {
    return { accepted: payload.accepted };
  }
  if (!response.ok || payload?.errors?.length) {
    throw new Error(extractDeleteError(payload, "Delete failed."));
  }
  return { deleted: true };
}
