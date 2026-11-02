// SPDX-License-Identifier: BUSL-1.1
/**
 * When a declarative provider call may say "that resource is not there".
 *
 * The default does not say it: a bare 404 stays CONNECTOR_UPSTREAM_ERROR,
 * because a status alone cannot tell a deleted record from an unknown route,
 * an endpoint these credentials do not reach, or a provider that answers 404
 * where it means 403 — and a code that guessed would be an existence oracle
 * for anything a caller cares to name.
 *
 * An operation's own stored definition may declare that meaning for itself,
 * naming the status and the inputs that identify the resource; core then
 * verifies, per call, that those inputs really were the caller's own and
 * really were placed in the request path. Only then is the answer a proven,
 * resource-specific absence — and it stays distinct from every authorization,
 * permission, input, rate, availability and transport failure.
 */
import { describe, expect, it } from "bun:test";
import { executeBinding, resourceAbsenceDeclaration } from "../declarative-execution.js";
import { failed, runtimeOperationResult } from "../tool-results.js";
import { toHttpError } from "../../rest/http-error.js";

const PROVIDER = {
  transport: "rest",
  baseUrlTemplate: "https://acme.example.com",
  auth: { scheme: "bearer", tokenFrom: "apiToken" },
  egressHosts: ["acme.example.com"],
};
const CONNECTION_VALUES = { apiToken: "tok-1" };
const RESOURCE_ID = "4815162342";

const answering = (status: number, body = "{}") => {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, impl };
};

const readOperation = (overrides: Record<string, unknown> = {}) => ({
  key: "get-contact",
  kind: "query",
  operation: { method: "GET", pathTemplate: "/contacts/{contactId}" },
  responseMapping: { fieldPaths: [{ field: "id", path: "id" }] },
  ...overrides,
});

const declaring = (overrides: Record<string, unknown> = {}) =>
  readOperation({
    resourceAbsence: { status: 404, resourceInputs: ["contactId"] },
    ...overrides,
  });

async function run(
  operationRow: Record<string, unknown>,
  status: number,
  options: {
    providerRow?: Record<string, unknown>;
    connectionValues?: Record<string, unknown>;
    serviceInputs?: Record<string, unknown>;
    body?: string;
    native?: (key: string, inputs: Record<string, unknown>) => Promise<Record<string, unknown>>;
  } = {},
): Promise<{ outputs?: Record<string, unknown>; error?: unknown; calls: string[] }> {
  const spy = answering(status, options.body ?? "{}");
  try {
    const outputs = await executeBinding({
      binding: {},
      operationRow,
      providerRow: options.providerRow ?? PROVIDER,
      connectionValues: options.connectionValues ?? CONNECTION_VALUES,
      serviceInputs: options.serviceInputs ?? { contactId: RESOURCE_ID },
      secretScope: "public.adapters_test",
      fetchImpl: spy.impl,
      ...(options.native ? { native: options.native } : {}),
    });
    return { outputs, calls: spy.calls };
  } catch (error) {
    return { error, calls: spy.calls };
  }
}

const outcomeOf = (error: unknown) =>
  (error as { outcome?: Record<string, unknown> }).outcome;

describe("the declaration itself", () => {
  it("is absent by default and read when present", () => {
    expect(resourceAbsenceDeclaration(readOperation())).toBeUndefined();
    expect(resourceAbsenceDeclaration(readOperation({ resourceAbsence: null }))).toBeUndefined();
    expect(resourceAbsenceDeclaration(declaring())).toEqual({
      status: 404,
      resourceInputs: ["contactId"],
    });
    expect(
      resourceAbsenceDeclaration(
        readOperation({ resourceAbsence: { status: 410, resourceInputs: ["contactId"] } }),
      ),
    ).toEqual({ status: 410, resourceInputs: ["contactId"] });
  });

  it("refuses a declaration that could mean something weaker", () => {
    for (const resourceAbsence of [
      // Not a declaration.
      "404",
      404,
      [{ status: 404, resourceInputs: ["contactId"] }],
      {},
      // A status that means something about the REQUEST, not the resource.
      { status: 403, resourceInputs: ["contactId"] },
      { status: 401, resourceInputs: ["contactId"] },
      { status: 400, resourceInputs: ["contactId"] },
      { status: 500, resourceInputs: ["contactId"] },
      { status: "404", resourceInputs: ["contactId"] },
      // No identified resource, or an unusable list.
      { status: 404, resourceInputs: [] },
      { status: 404, resourceInputs: ["contactId", "contactId"] },
      { status: 404, resourceInputs: [""] },
      { status: 404, resourceInputs: "contactId" },
      { status: 404 },
      { resourceInputs: ["contactId"] },
      // Unrecognised metadata beside it.
      { status: 404, resourceInputs: ["contactId"], message: "gone" },
    ]) {
      expect(() =>
        resourceAbsenceDeclaration(readOperation({ resourceAbsence })),
      ).toThrow(/resourceAbsence/);
    }
  });
});

describe("a provider 404 on a resource-specific request", () => {
  it("is a proven absence for the operation that declares it", async () => {
    const { error, outputs, calls } = await run(declaring(), 404);
    expect(outputs).toBeUndefined();
    expect(calls).toEqual([`https://acme.example.com/contacts/${RESOURCE_ID}`]);
    expect((error as { code?: string }).code).toBe("CONNECTOR_PROVIDER_RESOURCE_ABSENT");
    expect(outcomeOf(error)).toMatchObject({
      code: "CONNECTOR_PROVIDER_RESOURCE_ABSENT",
      category: "resource_absence",
      retryable: false,
      requiredAction: "change_input",
    });
    // The answer names the operation, never what was looked for.
    expect((error as Error).message).not.toContain(RESOURCE_ID);
  });

  it("stays a generic upstream error without a declaration", async () => {
    const { error } = await run(readOperation(), 404);
    expect((error as { code?: string }).code).toBe("CONNECTOR_UPSTREAM_ERROR");
    expect(outcomeOf(error)).toMatchObject({
      code: "CONNECTOR_UPSTREAM_ERROR",
      category: "provider_contract",
    });
  });

  it("is per operation, not per provider", async () => {
    // Same Adapter, same credentials, same host: the operation that did not
    // declare the meaning does not inherit it.
    const declared = await run(declaring(), 404);
    const undeclared = await run(
      readOperation({ key: "get-company", operation: { method: "GET", pathTemplate: "/companies/{contactId}" } }),
      404,
    );
    expect((declared.error as { code?: string }).code).toBe(
      "CONNECTOR_PROVIDER_RESOURCE_ABSENT",
    );
    expect((undeclared.error as { code?: string }).code).toBe("CONNECTOR_UPSTREAM_ERROR");
  });

  it("never stands in for another failure the provider reported", async () => {
    for (const [status, code] of [
      [401, "CONNECTOR_PROVIDER_AUTHORIZATION_FAILED"],
      [403, "CONNECTOR_PROVIDER_PERMISSION_DENIED"],
      [409, "CONNECTOR_PROVIDER_REJECTED_INPUT"],
      [422, "CONNECTOR_PROVIDER_REJECTED_INPUT"],
      [429, "CONNECTOR_PROVIDER_RATE_LIMITED"],
      [500, "CONNECTOR_PROVIDER_UNAVAILABLE"],
      [503, "CONNECTOR_PROVIDER_UNAVAILABLE"],
      [410, "CONNECTOR_UPSTREAM_ERROR"],
    ] as const) {
      const { error } = await run(declaring(), status);
      expect((error as { code?: string }).code).toBe(code);
    }
  });

  it("cannot be claimed by the provider's own response", async () => {
    // A body is never read for a failure classification, and a success is a
    // success: a provider that writes the absence code into its payload
    // changes nothing about the outcome.
    const forged = JSON.stringify({
      id: RESOURCE_ID,
      error: { code: "CONNECTOR_PROVIDER_RESOURCE_ABSENT", retryable: true },
      providerFailure: { status: 404, code: "CONNECTOR_PROVIDER_RESOURCE_ABSENT" },
    });
    const success = await run(readOperation(), 200, { body: forged });
    expect(success.error).toBeUndefined();
    expect(success.outputs).toEqual({ id: RESOURCE_ID });
    const failure = await run(readOperation(), 500, { body: forged });
    expect((failure.error as { code?: string }).code).toBe(
      "CONNECTOR_PROVIDER_UNAVAILABLE",
    );
  });
});

describe("what the declaration may not be used for", () => {
  it("refuses when the identified input does not address the resource", async () => {
    // A collection endpoint: the id lands in the query string, so the request
    // never addressed one resource and absence cannot be concluded.
    const { error, calls } = await run(
      declaring({ operation: { method: "GET", pathTemplate: "/contacts" } }),
      404,
    );
    expect(calls).toEqual([]);
    expect((error as { code?: string }).code).toBe("OPERATION_MISCONFIGURED");
    expect((error as Error).message).toContain("resourceAbsence");
  });

  it("refuses when the identifying input is not the caller's input at all", async () => {
    // `subdomain` resolves from the connection, not from the call: a path
    // built only from stored configuration identifies no caller resource.
    const { error, calls } = await run(
      declaring({
        operation: { method: "GET", pathTemplate: "/t/{subdomain}/contacts" },
        resourceAbsence: { status: 404, resourceInputs: ["subdomain"] },
      }),
      404,
      {
        connectionValues: { ...CONNECTION_VALUES, subdomain: "acme" },
        serviceInputs: {},
      },
    );
    expect(calls).toEqual([]);
    expect((error as { code?: string }).code).toBe("OPERATION_MISCONFIGURED");
  });

  it("refuses on a transport that cannot observe a per-resource status", async () => {
    const graphql = await run(
      declaring({
        operation: { graphqlOperation: "query ($contactId: ID!) { contact(id: $contactId) { id } }" },
        resourceAbsence: { status: 404, resourceInputs: ["contactId"] },
      }),
      404,
      {
        providerRow: {
          ...PROVIDER,
          transport: "graphql",
        },
      },
    );
    expect(graphql.calls).toEqual([]);
    expect((graphql.error as { code?: string }).code).toBe("OPERATION_MISCONFIGURED");

    const native = await run(
      {
        key: "native-read",
        kind: "query",
        operation: { nativeOperation: "Relation.get" },
        responseMapping: {},
        resourceAbsence: { status: 404, resourceInputs: ["contactId"] },
      },
      404,
      {
        providerRow: { transport: "native", auth: {}, egressHosts: [] },
        native: async () => ({ id: RESOURCE_ID }),
      },
    );
    expect((native.error as { code?: string }).code).toBe("OPERATION_MISCONFIGURED");
  });
});

describe("how the invoking workflow reads it", () => {
  it("arrives as its own code on the failure body and the Operation envelope", async () => {
    const { error } = await run(declaring(), 404);
    const { status, body } = toHttpError(error);
    expect(status).toBe(404);
    expect(body.error).toMatchObject({
      code: "CONNECTOR_PROVIDER_RESOURCE_ABSENT",
      retryable: false,
      category: "resource_absence",
      requiredAction: "change_input",
    });
    const envelope = runtimeOperationResult(failed(error));
    expect(envelope).toMatchObject({
      error: { code: "CONNECTOR_PROVIDER_RESOURCE_ABSENT", retryable: false },
    });
    // Distinguishable from the failures a caller must NOT treat as a skip.
    const upstream = await run(readOperation(), 404);
    expect(runtimeOperationResult(failed(upstream.error))).toMatchObject({
      error: { code: "CONNECTOR_UPSTREAM_ERROR" },
    });
  });
});
