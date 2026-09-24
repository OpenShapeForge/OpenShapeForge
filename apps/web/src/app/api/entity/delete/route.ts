// SPDX-License-Identifier: BUSL-1.1
import { executeGraphqlRequest } from "@/lib/server/graphql-client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DELETE_MUTATION = /^delete([A-Z][_0-9A-Za-z]*)$/;

type DeleteRequest = {
  mutationName?: unknown;
  id?: unknown;
  expectedVersion?: unknown;
  confirmed?: unknown;
};

function badRequest(message: string): Response {
  return Response.json({ message }, { status: 400 });
}

/**
 * Browser adapter for generated record actions. Authentication and tenant
 * context stay in the existing server-side GraphQL gateway; the browser may
 * choose only a compiler-shaped delete mutation and supplies the confirmation
 * and record version it obtained from the rendered canonical contract.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as DeleteRequest | null;
  if (!body) return badRequest("A JSON delete request is required.");
  if (typeof body.mutationName !== "string") return badRequest("mutationName is required.");
  const match = body.mutationName.match(DELETE_MUTATION);
  if (!match) return badRequest("mutationName is not a generated delete mutation.");
  if (typeof body.id !== "string" || !UUID.test(body.id)) return badRequest("id must be a UUID.");
  if (typeof body.expectedVersion !== "string" || !Number.isFinite(Date.parse(body.expectedVersion))) {
    return badRequest("expectedVersion must be a timestamp.");
  }
  if (body.confirmed !== true) return badRequest("Deletion must be explicitly confirmed.");

  const typeName = match[1]!;
  const query = `mutation Delete${typeName}($input: Delete${typeName}Input!) {
    ${body.mutationName}(input: $input) {
      data { deleted }
      error { code message retryable }
    }
  }`;
  const result = await executeGraphqlRequest<Record<string, {
    data?: { deleted?: boolean } | null;
    error?: { code?: string; message?: string } | null;
  } | null>>({
    query,
    // The mutation name and input type are selected from the compiler naming
    // convention after the strict shape check above, so this deliberately uses
    // the authenticated dynamic-operation profile.
    profile: "integration",
    variables: {
      input: {
        id: body.id,
        expectedVersion: body.expectedVersion,
        confirmed: true,
      },
    },
  });
  const deletion = result[body.mutationName];
  if (deletion?.error) {
    return Response.json({
      errors: [{
        message: `${deletion.error.code ?? "OPERATION_FAILED"}: ${deletion.error.message ?? "Delete failed."}`,
      }],
    });
  }
  if (deletion?.data?.deleted !== true) {
    return Response.json({ errors: [{ message: "Delete returned no deleted record." }] });
  }
  return Response.json({ deleted: true });
}
