// SPDX-License-Identifier: BUSL-1.1
"use server";

/**
 * The integrations page's server actions.
 *
 * Every mutation here already existed on the API — this file adds no policy and
 * makes no decision the connector service does not already make. Configuration
 * hands credentials for another system to the platform, and the API refuses a
 * caller without `Platform.ConnectorAdmin` regardless of what this page renders.
 * So the page hides what an operator cannot use; it does not enforce it.
 *
 * Reads opt out of the process-local query cache (`queryCache: false`): the
 * catalog is a mutating authoring surface, and a refresh immediately after
 * saving must not be answered from a copy taken before it.
 */
import { revalidatePath } from "next/cache";
import {
  buildGraphqlGatewayRequestContext,
  executeGraphqlRequest,
} from "@/lib/server/graphql-client";
import { buildGatewayUrl } from "@/lib/server/gateway";
import type { Connector } from "@/features/integrations/types";

const CONNECTOR_FIELDS = /* GraphQL */ `
  slug
  name
  title
  category
  license {
    spdx
    url
    notice
  }
  provenance
  requiredEntitlement
  status
  configFields
  instances
  supportsVerify
  usesOAuth
  requiresAuthorization
  installations {
    instanceKey
    displayName
    enabled
    configuration
    contract {
      state
      missingRequiredFields
      removedFields
      reason
      requiresReverification
    }
  }
`;

const CONNECTORS_QUERY = /* GraphQL */ `
  query Connectors {
    connectors {
      ${CONNECTOR_FIELDS}
    }
  }
`;

const CONNECTOR_QUERY = /* GraphQL */ `
  query Connector($slug: ID!) {
    connector(slug: $slug) {
      ${CONNECTOR_FIELDS}
    }
  }
`;

export async function listConnectors(): Promise<Connector[]> {
  const data = await executeGraphqlRequest<{ connectors: Connector[] }>({
    query: CONNECTORS_QUERY,
    queryCache: false,
  });
  return data.connectors ?? [];
}

export async function getConnector(slug: string): Promise<Connector | null> {
  const data = await executeGraphqlRequest<{ connector: Connector | null }>({
    query: CONNECTOR_QUERY,
    variables: { slug },
    queryCache: false,
  });
  return data.connector ?? null;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Coded API errors are the useful half of a failure here — CONNECTOR_NEEDS_REPAIR
 * and CONNECTOR_INVALID_CONFIGURATION tell an operator what to do next, where a
 * generic "save failed" does not. The message is surfaced as-is because the API
 * has already decided what is safe to say; nothing is added to it.
 */
function toActionResult(error: unknown): ActionResult {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: message };
}

/**
 * Save non-secret configuration.
 *
 * Secret-marked fields are deliberately NOT accepted here: they travel through
 * `setConnectorSecret` one at a time. Folding them into this payload would mean
 * a form that re-submits every field also re-submits the `__set__` sentinel it
 * read back, storing the literal string as a credential.
 */
export async function saveConnectorConfiguration(input: {
  slug: string;
  instanceKey: string;
  displayName?: string | null;
  configuration: Record<string, unknown>;
}): Promise<ActionResult> {
  try {
    await executeGraphqlRequest({
      query: /* GraphQL */ `
        mutation ConfigureConnector($input: ConfigureConnectorInput!) {
          configureConnector(input: $input) {
            instanceKey
          }
        }
      `,
      variables: {
        input: {
          slug: input.slug,
          instanceKey: input.instanceKey,
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          configuration: input.configuration,
        },
      },
    });
    revalidatePath(`/integrations/${input.slug}`);
    return { ok: true };
  } catch (error) {
    return toActionResult(error);
  }
}

export async function setConnectorSecret(input: {
  slug: string;
  instanceKey: string;
  field: string;
  value: string;
}): Promise<ActionResult> {
  try {
    await executeGraphqlRequest({
      query: /* GraphQL */ `
        mutation SetConnectorSecret(
          $slug: ID!
          $instanceKey: String
          $field: String!
          $value: String!
        ) {
          setConnectorSecret(
            slug: $slug
            instanceKey: $instanceKey
            field: $field
            value: $value
          )
        }
      `,
      variables: input,
    });
    revalidatePath(`/integrations/${input.slug}`);
    return { ok: true };
  } catch (error) {
    return toActionResult(error);
  }
}

export async function setConnectorEnabled(input: {
  slug: string;
  instanceKey: string;
  enabled: boolean;
}): Promise<ActionResult> {
  try {
    await executeGraphqlRequest({
      query: input.enabled
        ? /* GraphQL */ `
            mutation EnableConnector($slug: ID!, $instanceKey: String) {
              enableConnector(slug: $slug, instanceKey: $instanceKey)
            }
          `
        : /* GraphQL */ `
            mutation DisableConnector($slug: ID!, $instanceKey: String) {
              disableConnector(slug: $slug, instanceKey: $instanceKey)
            }
          `,
      variables: { slug: input.slug, instanceKey: input.instanceKey },
    });
    revalidatePath(`/integrations/${input.slug}`);
    return { ok: true };
  } catch (error) {
    return toActionResult(error);
  }
}

export type VerifyResult =
  | { ok: true; message?: string | null }
  | { ok: false; error: string };

/**
 * Run the contract's connectivity check.
 *
 * A failed check is an ANSWER, not an error: the operator asked whether the
 * credentials work and "no" is a valid reply, carried in `message`. Only a
 * refusal to run the check at all — unauthorized, unconfigured, no such
 * connector — comes back as `error`.
 */
export async function verifyConnector(input: {
  slug: string;
  instanceKey: string;
}): Promise<VerifyResult> {
  try {
    const data = await executeGraphqlRequest<{
      verifyConnector: { ok: boolean; message: string | null };
    }>({
      query: /* GraphQL */ `
        mutation VerifyConnector($slug: ID!, $instanceKey: String) {
          verifyConnector(slug: $slug, instanceKey: $instanceKey) {
            ok
            message
          }
        }
      `,
      variables: input,
    });
    const result = data.verifyConnector;
    return result.ok
      ? { ok: true, message: result.message }
      : { ok: false, error: result.message ?? "Connectivity check failed." };
  } catch (error) {
    return toActionResult(error) as VerifyResult;
  }
}

/**
 * Start an OAuth authorization.
 *
 * The API answers with the provider URL rather than redirecting, so the browser
 * navigation stays the front end's decision — a redirect from the API would
 * make the authenticated half of the flow a cross-site navigation and lose the
 * session that authorizes it.
 *
 * This is the one connector call that is REST rather than GraphQL, because the
 * flow it starts is a browser round trip that ends at a REST callback. Putting
 * half of it behind a GraphQL mutation would split one flow across two
 * transports for no gain.
 */
export async function startConnectorAuthorization(input: {
  slug: string;
  instanceKey: string;
}): Promise<{ ok: true; authorizeUrl: string } | { ok: false; error: string }> {
  try {
    const { headers } = await buildGraphqlGatewayRequestContext();
    const url = buildGatewayUrl(
      `/api/rest/v1/connectors/${encodeURIComponent(input.slug)}/installations/` +
        `${encodeURIComponent(input.instanceKey)}/authorize`,
    );
    const response = await fetch(url, { method: "POST", headers, cache: "no-store" });
    const payload = (await response.json().catch(() => ({}))) as {
      authorizeUrl?: string;
      error?: { message?: string };
    };
    if (!response.ok || typeof payload.authorizeUrl !== "string") {
      return {
        ok: false,
        error: payload.error?.message ?? `Could not start authorization (${response.status}).`,
      };
    }
    return { ok: true, authorizeUrl: payload.authorizeUrl };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
