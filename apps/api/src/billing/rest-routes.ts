// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveSessionContext } from "../auth/identity.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import { headersFromFastify } from "../http/headers.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import {
  createAgreementMilestone,
  runMilestoneBillingRun,
  triggerAgreementMilestone,
  type AgreementMilestoneInput,
  type MilestoneBillingRunInput,
} from "./agreement-milestone-service.js";

export const AGREEMENT_MILESTONE_PATH = "/api/agreement-milestones";
export const MILESTONE_BILLING_RUN_PATH = "/api/billing-runs/milestone";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "BAD_USER_INPUT", `${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function parseBody(body: unknown): Record<string, unknown> {
  let value = body;
  try {
    if (typeof body === "string") value = JSON.parse(body);
    if (body instanceof Uint8Array) value = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new HttpError(400, "BAD_USER_INPUT", "Request body is not valid JSON.");
  }
  return parseObject(value, "Request body");
}

export function parseAgreementMilestoneBody(body: unknown): AgreementMilestoneInput {
  const parsed = parseBody(body);
  const allowed = new Set(["agreementId", "description", "basisAmount", "percentOfBasis", "amount"]);
  const unknown = Object.keys(parsed).find((key) => !allowed.has(key));
  if (unknown) throw new HttpError(400, "BAD_USER_INPUT", `Unknown request field "${unknown}".`);
  return parsed as unknown as AgreementMilestoneInput;
}

export function parseTriggerBody(body: unknown): { triggeredBy?: string } {
  if (body === undefined || body === null) return {};
  const parsed = parseBody(body);
  const allowed = new Set(["triggeredBy"]);
  const unknown = Object.keys(parsed).find((key) => !allowed.has(key));
  if (unknown) throw new HttpError(400, "BAD_USER_INPUT", `Unknown request field "${unknown}".`);
  if (parsed.triggeredBy !== undefined && typeof parsed.triggeredBy !== "string") {
    throw new HttpError(400, "BAD_USER_INPUT", "triggeredBy must be a string.");
  }
  return parsed as { triggeredBy?: string };
}

export function parseMilestoneBillingRunBody(body: unknown): MilestoneBillingRunInput {
  const parsed = parseBody(body);
  const allowed = new Set(["idempotencyKey", "agreementFilter", "dryRun", "triggeredBy"]);
  const unknown = Object.keys(parsed).find((key) => !allowed.has(key));
  if (unknown) throw new HttpError(400, "BAD_USER_INPUT", `Unknown request field "${unknown}".`);
  if (parsed.agreementFilter !== undefined) {
    const filter = parseObject(parsed.agreementFilter, "agreementFilter");
    const filterUnknown = Object.keys(filter).find((key) => key !== "agreementId");
    if (filterUnknown) {
      throw new HttpError(400, "BAD_USER_INPUT", `Unknown agreementFilter field "${filterUnknown}".`);
    }
  }
  return parsed as unknown as MilestoneBillingRunInput;
}

async function requireContext(
  request: FastifyRequest,
  db: OpenShapeForgeDatabase | undefined,
): Promise<{ db: OpenShapeForgeDatabase; session: DbSessionInput }> {
  const resolved = await resolveSessionContext(headersFromFastify(request.headers), { db });
  if (!resolved.tenantId || !resolved.userId) {
    throw new HttpError(401, "UNAUTHENTICATED", "Billing commands require an authenticated session.");
  }
  if (!db) {
    throw new HttpError(503, "DATABASE_NOT_CONFIGURED", "Database is not configured for billing commands.");
  }
  return {
    db,
    session: {
      tenantId: resolved.tenantId,
      userId: resolved.userId,
      roles: [...resolved.roles],
      groups: [...resolved.groups],
      scope: resolved.scope,
    },
  };
}

export function registerAgreementMilestoneRestRoutes(
  app: FastifyInstance,
  options: { db?: OpenShapeForgeDatabase | undefined } = {},
): void {
  void app.register(async (instance) => {
    instance.setErrorHandler((error, _request, reply) => {
      const { status, body } = toHttpError(error);
      if (status >= 500) instance.log.error({ err: error }, "Milestone billing command failed.");
      void reply.status(status).send(body);
    });

    instance.post(AGREEMENT_MILESTONE_PATH, async (request, reply) => {
      const context = await requireContext(request, options.db);
      const input = parseAgreementMilestoneBody(request.body);
      const created = await createAgreementMilestone(context.db, context.session, input);
      return reply.status(201).send(created);
    });

    instance.post(`${AGREEMENT_MILESTONE_PATH}/:agreementMilestoneId/trigger`, async (request, reply) => {
      const context = await requireContext(request, options.db);
      const { agreementMilestoneId } = request.params as { agreementMilestoneId: string };
      if (!UUID_PATTERN.test(agreementMilestoneId)) {
        throw new HttpError(400, "BAD_USER_INPUT", "agreementMilestoneId must be a UUID.");
      }
      const { triggeredBy } = parseTriggerBody(request.body);
      const updated = await triggerAgreementMilestone(
        context.db,
        context.session,
        agreementMilestoneId,
        triggeredBy,
      );
      return reply.status(200).send(updated);
    });

    instance.post(MILESTONE_BILLING_RUN_PATH, async (request, reply) => {
      const context = await requireContext(request, options.db);
      const input = parseMilestoneBillingRunBody(request.body);
      const result = await runMilestoneBillingRun(context.db, context.session, input);
      return reply.status(200).send(result);
    });
  });
}
