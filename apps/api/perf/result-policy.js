// SPDX-License-Identifier: BUSL-1.1
/** Pure outcome policy shared by k6 and the failure-accounting regression. */
export function operationOutcome(status, body, field, op, expectedChallenge = false) {
  if (status !== 200 || !body || body.errors?.length || !body.data?.[field]) return { ok: false };
  const result = body.data[field];
  if (expectedChallenge) {
    const token = result.error?.data?.confirmation?.challengeToken;
    return {
      ok: result.error?.code === "CONFIRMATION_REQUIRED" && typeof token === "string" && token.length > 0 && !result.data,
      challengeToken: token,
    };
  }
  if (result.error || !result.data) return { ok: false };
  const data = result.data;
  const ok = op === "delete" ? data.deleted === true
    : op === "list" ? Array.isArray(data.items) && data.items.length > 0
    : typeof data.id === "string" && data.id.length > 0;
  return { ok, data };
}

/** The one proven owning-companion exception; other refusals remain failures. */
export function documentLifecycleException(entity, references, versionPolicy) {
  return entity === "Document" && references.length === 1 &&
    references[0] === "erp.document_versions.document_id" &&
    versionPolicy.update === false && versionPolicy.delete === false;
}
