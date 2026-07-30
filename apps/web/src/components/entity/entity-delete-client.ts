// SPDX-License-Identifier: BUSL-1.1
const ENTITY_DELETE_ENDPOINT = "/api/entity/delete";

type EntityDeletePayload = {
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
}): Promise<void> {
  const response = await fetch(ENTITY_DELETE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mutationName: options.mutationName,
      id: options.entityId,
    }),
  });

  const payload = await response.json().catch(() => null) as EntityDeletePayload | null;
  if (!response.ok || payload?.errors?.length) {
    throw new Error(extractDeleteError(payload, "Delete failed."));
  }
}
