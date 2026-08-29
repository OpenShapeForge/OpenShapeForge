// SPDX-License-Identifier: BUSL-1.1
/**
 * Verification of an elicited row's stored values — the `mcp.test` tool.
 *
 * A row whose values were collected by elicitation (a connection) is only
 * proven useful by exercising it, and the honest report of a partial check is
 * part of the contract: the result names each check as passed, failed, or
 * skipped with the reason, so "your credentials are shaped correctly" is
 * never mistaken for "your credentials work".
 *
 * Three checks, in order:
 *   1. required-values — every definition the source row requires, plus every
 *      credential key its auth block references, has a stored value.
 *   2. credentials — the auth headers actually resolve. For the OAuth
 *      client-credentials scheme this performs a REAL token round-trip
 *      (egress-gated); for local schemes it is a resolution check only.
 *   3. probe — when the source row declares a `probe` request (canonical
 *      fields `method`, `pathTemplate`), it is sent with the resolved
 *      credentials against the resolved base URL, egress-gated, and judged by
 *      HTTP status. Without a probe the check is reported as skipped: the
 *      credentials were checked but never exercised.
 *
 * Secrets never appear in the report — not in details, not in errors.
 */
import { HttpError } from "../rest/http-error.js";
import { hostAllowed } from "../connectors/executor.js";
import {
  decryptSecret,
  keyringFromEnv,
  type SecretKeyring,
  type StoredSecret,
} from "../connectors/secrets.js";
import {
  acquireAuthHeaders,
  resolveTemplate,
  splitConnectionValues,
} from "./declarative-execution.js";
import { requiredAuthValueKeys } from "./publication-validation.js";
import type { ElicitOnCreateEntry } from "./elicitation.js";

type JsonRecord = Record<string, unknown>;

const KEYRING_ENV = "OPENSHAPEFORGE_ELICITED_SECRET_KEYS";
const PROBE_TIMEOUT_MS = 15_000;

/** Runtime-issued token fields live under the personal scope, not the elicited one. */
const TOKEN_FIELDS = new Set(["accessToken", "refreshToken"]);

export type ConnectionTestCheck = {
  check: "required-values" | "credentials" | "probe";
  outcome: "passed" | "failed" | "skipped";
  detail: string;
};

export type ConnectionTestReport = {
  ok: boolean;
  /** Display name of the source (provider) row the values were tested against. */
  source: string;
  checks: ConnectionTestCheck[];
};

function requiredDefinitionKeys(definitions: unknown): string[] {
  if (!Array.isArray(definitions)) return [];
  return (definitions as JsonRecord[])
    .filter((definition) => definition?.required === true && typeof definition.key === "string")
    .map((definition) => definition.key as string);
}

function hasValue(values: JsonRecord, key: string): boolean {
  const value = values[key];
  return value !== undefined && value !== null && value !== "";
}

export type TestElicitedRowInput = {
  /** The elicited row under test. */
  row: JsonRecord;
  /** The source (provider) row its values configure. */
  sourceRow: JsonRecord;
  elicit: ElicitOnCreateEntry;
  /** Physical table of the elicited entity, for the personal token scope. */
  table: string;
  /**
   * Plain values of the tenant-owned sibling row, merged UNDER the row's own
   * values — a personal row holds only tokens, while URL templates resolve
   * from tenant configuration, exactly as execution merges them.
   */
  fallbackPlainValues?: Record<string, string> | undefined;
  keyring?: SecretKeyring | undefined;
  fetchImpl?: typeof fetch;
};

/** One line per failed check, for refusals that must explain themselves. */
export function failedCheckSummary(report: ConnectionTestReport): string {
  return report.checks
    .filter((check) => check.outcome === "failed")
    .map((check) => `${check.check}: ${check.detail}`)
    .join(" ");
}

export async function testElicitedRow(input: TestElicitedRowInput): Promise<ConnectionTestReport> {
  const { row, sourceRow, elicit } = input;
  const keyring = input.keyring ?? keyringFromEnv(process.env[KEYRING_ENV]);
  const fetchImpl = input.fetchImpl ?? fetch;
  const checks: ConnectionTestCheck[] = [];
  const sourceName = String(sourceRow.name ?? sourceRow.key ?? elicit.sourceEntity);
  const values = (row[elicit.into] ?? {}) as JsonRecord;
  const auth = (sourceRow.auth ?? null) as JsonRecord | null;
  const isPersonal = Boolean(row.ownerUserId);

  // 1. Required values. A personal row holds runtime-issued tokens, so it is
  // judged on those; a tenant row is judged on the elicited contract.
  const requiredKeys = isPersonal
    ? ["accessToken"]
    : [
        ...new Set([
          ...requiredDefinitionKeys(sourceRow[elicit.definitionsField]),
          ...requiredAuthValueKeys(auth),
        ]),
      ];
  const missing = requiredKeys.filter((key) => !hasValue(values, key)).sort();
  checks.push(
    missing.length === 0
      ? {
          check: "required-values",
          outcome: "passed",
          detail: `All required values are set${requiredKeys.length > 0 ? ` (${requiredKeys.sort().join(", ")})` : ""}.`,
        }
      : {
          check: "required-values",
          outcome: "failed",
          detail: `Missing required values: ${missing.join(", ")}. Recreate the ${elicit.sourceEntity.toLowerCase()} connection to enter them.`,
        },
  );

  // 2 + 3 share the resolved credentials, so a decryption or resolution
  // failure fails the credentials check and skips the probe.
  let plain: Record<string, string> = {};
  let headers: Record<string, string> | undefined;
  const egress = Array.isArray(sourceRow.egressHosts) ? (sourceRow.egressHosts as string[]) : [];
  const personalTokens = Boolean(values.accessToken);
  // Sign-in providers execute with the runtime-issued bearer token; every
  // other contract executes with the source row's own auth block.
  const effectiveAuth =
    auth?.profile === "oauth2AuthorizationCode"
      ? personalTokens
        ? { scheme: "bearer", tokenFrom: "accessToken" }
        : undefined
      : auth;
  try {
    const split = splitConnectionValues(values, (stored: StoredSecret, field: string) => {
      if (!keyring) {
        throw new HttpError(
          500,
          "SECRET_KEYRING_MISSING",
          `A stored secret needs the keyring; set ${KEYRING_ENV}.`,
        );
      }
      // Token fields were encrypted by the sign-in callback under the
      // personal scope; elicited fields under the source table scope.
      const scope = TOKEN_FIELDS.has(field) ? `${input.table}:personal` : elicit.sourceTable;
      return decryptSecret(keyring, scope, field, stored);
    });
    plain = { ...(input.fallbackPlainValues ?? {}), ...split.plain };
    if (effectiveAuth === undefined) {
      checks.push({
        check: "credentials",
        outcome: "skipped",
        detail:
          "This connection holds the sign-in client only; tokens are issued per person " +
          "after they approve at the provider, so there is nothing to exercise yet.",
      });
    } else {
      headers = await acquireAuthHeaders({
        auth: effectiveAuth,
        plain,
        secret: split.secret,
        egress,
        fetchImpl,
      });
      checks.push({
        check: "credentials",
        outcome: "passed",
        detail:
          (effectiveAuth as JsonRecord | null)?.scheme === "oauth2ClientCredentials"
            ? "The token endpoint accepted the client credentials and issued a token."
            : "The credentials resolve into request authentication.",
      });
    }
  } catch (error) {
    checks.push({
      check: "credentials",
      outcome: "failed",
      detail: error instanceof HttpError ? error.message : "Credential resolution failed.",
    });
  }

  // 3. Probe — only with resolved credentials and a declared probe request.
  const probe = (sourceRow.probe ?? null) as JsonRecord | null;
  const pathTemplate = typeof probe?.pathTemplate === "string" ? probe.pathTemplate : "";
  if (!probe || !pathTemplate.startsWith("/")) {
    checks.push({
      check: "probe",
      outcome: "skipped",
      detail:
        `The ${elicit.sourceEntity} declares no probe request, so the values were not ` +
        `exercised against the provider. Declare probe { method, pathTemplate } on it ` +
        `for a full check.`,
    });
  } else if (headers === undefined) {
    checks.push({
      check: "probe",
      outcome: "skipped",
      detail: "Skipped because the credentials check did not produce request authentication.",
    });
  } else {
    try {
      const baseUrl = resolveTemplate(
        typeof sourceRow.baseUrlTemplate === "string" ? sourceRow.baseUrlTemplate : "",
        plain,
        "source baseUrlTemplate",
      );
      const path = resolveTemplate(pathTemplate, plain, "probe pathTemplate");
      const url = new URL(baseUrl.replace(/\/$/, "") + path);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new HttpError(400, "EGRESS_DENIED", "Only http(s) probes are supported.");
      }
      if (!hostAllowed(url.hostname, egress)) {
        throw new HttpError(
          403,
          "EGRESS_DENIED",
          `Probe host ${url.hostname} is not in the egress allow-list.`,
        );
      }
      const method = typeof probe.method === "string" ? probe.method.toUpperCase() : "GET";
      const response = await fetchImpl(url, {
        method,
        headers: { accept: "application/json", ...headers },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      checks.push(
        response.ok
          ? {
              check: "probe",
              outcome: "passed",
              detail: `${method} ${url.pathname} answered ${response.status}.`,
            }
          : {
              check: "probe",
              outcome: "failed",
              detail:
                `${method} ${url.pathname} answered ${response.status}` +
                (response.status === 401 || response.status === 403
                  ? " — the provider refused these credentials."
                  : "."),
            },
      );
    } catch (error) {
      checks.push({
        check: "probe",
        outcome: "failed",
        detail: error instanceof HttpError ? error.message : "The probe request did not complete.",
      });
    }
  }

  return {
    ok: checks.every((check) => check.outcome !== "failed"),
    source: sourceName,
    checks,
  };
}
