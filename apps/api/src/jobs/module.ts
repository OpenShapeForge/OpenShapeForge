// SPDX-License-Identifier: BUSL-1.1
/**
 * The core `osf-jobs` runtime module: the `job-worker` role and the
 * `mail.deliver` job kind. Core rather than a plugin because the outbox is
 * what plugins build on — a deployment must not be able to drop it — and
 * because its Operations bind in every process like the control ones do
 * (operations/runtime.ts). It is created by the worker role with the loaded
 * plugin modules in hand, so the handler registry it drains is composed from
 * every active module, this one included.
 */
import { randomUUID } from "node:crypto";
import type { RuntimeWorkerOperationBroker } from "@openshapeforge/plugin-runtime";
import { serviceIdentityEndpoint } from "../auth/organization-service-identities.js";
import { keyringFromEnv } from "../platform/secrets.js";
import type { ModuleJobHandler, RuntimeModule } from "../modules/contract.js";
import { composeJobHandlers } from "./handlers.js";
import { createInboundDispatchHandler } from "./inbound/dispatch.js";
import { INBOUND_DISPATCH_KIND } from "./inbound/kind.js";
import {
  markInboundOperationDispatch, pinInboundOperationContract, resolveInboundOperationWork,
} from "./inbound/work.js";
import { createMailDeliverHandler, MAIL_DELIVER_KIND } from "./mail/deliver.js";
import { createNullMailProvider, type MailProvider } from "./mail/provider.js";
import { createSmtpMailProvider, readSmtpConfig } from "./mail/smtp.js";
import { JOBS_PLUGIN } from "./operations.js";
import { JOB_WORKER_ROLE, readJobWorkerOptions, startJobWorker } from "./worker.js";

export { JOBS_PLUGIN, JOB_WORKER_ROLE };

export const MAIL_PROVIDER_ENV = "OPENSHAPEFORGE_MAIL_PROVIDER";

/**
 * The transport a deployment configured, or a refusal. SMTP when
 * `OPENSHAPEFORGE_SMTP_URL` is set; the logging null provider only on the
 * explicit `OPENSHAPEFORGE_MAIL_PROVIDER=null` **and** an explicit
 * `NODE_ENV=development` — a staging or unlabelled worker that quietly
 * dropped every message would be worse than one that did not start. Nothing
 * else is a configuration, so the worker refuses to start on it.
 */
export function configuredMailProvider(env: NodeJS.ProcessEnv = process.env): MailProvider {
  const smtp = readSmtpConfig(env);
  if (smtp) return createSmtpMailProvider(smtp);
  const selected = env[MAIL_PROVIDER_ENV]?.trim();
  if (selected === "null") {
    if (env.NODE_ENV !== "development") {
      throw new Error(
        `${MAIL_PROVIDER_ENV}=null is accepted only with NODE_ENV=development; ` +
          `outside development a job-worker needs OPENSHAPEFORGE_SMTP_URL.`,
      );
    }
    return createNullMailProvider();
  }
  if (selected) throw new Error(`${MAIL_PROVIDER_ENV} "${selected}" is unknown; set OPENSHAPEFORGE_SMTP_URL, or ${MAIL_PROVIDER_ENV}=null with NODE_ENV=development.`);
  throw new Error(`No mail transport is configured: set OPENSHAPEFORGE_SMTP_URL, or ${MAIL_PROVIDER_ENV}=null with NODE_ENV=development to log messages instead.`);
}

export type JobsRuntimeModuleOptions = {
  /** The other active modules; their `jobHandlers` join this module's. */
  modules: () => readonly RuntimeModule[];
  env?: NodeJS.ProcessEnv;
  mailProvider?: MailProvider;
};

/**
 * Whether this host can authorize a durable machine dispatch at all.
 *
 * `roles/worker.ts` builds the broker as soon as a worker contributes
 * `resolveOperationWork`, and `createDurableWorkerBroker` validates both
 * endpoints when it is CONSTRUCTED — so contributing them unconditionally
 * would stop `job-worker` from starting on every deployment that has not
 * configured a service identity, taking `mail.deliver` down with it. Core's
 * queue must keep draining on a host that simply has no inbound endpoints, so
 * the contribution is gated here and the dispatch handler fails closed.
 */
export function durableDispatchConfigured(env: NodeJS.ProcessEnv): boolean {
  try {
    serviceIdentityEndpoint(env.OPENSHAPEFORGE_OPERATION_API_URL, "Canonical Operation API");
    serviceIdentityEndpoint(env.OPENSHAPEFORGE_SERVICE_IDENTITY_TOKEN_URL, "Service identity token endpoint");
    return true;
  } catch {
    return false;
  }
}

export function createJobsRuntimeModule(options: JobsRuntimeModuleOptions): RuntimeModule {
  const env = options.env ?? process.env;
  // Resolved when the worker starts, not when the module is created: the API
  // process composes this module to validate the job kinds and never sends.
  let provider = options.mailProvider;
  const resolve = (): MailProvider => (provider ??= configuredMailProvider(env));
  const lazy: MailProvider = { get name() { return resolve().name; }, send: (message) => resolve().send(message) };
  // The durable broker exists only once the worker role starts with it: the
  // handler registry is composed when this module is created, which the API
  // process also does (to validate the kinds) without ever draining anything.
  // So the inbound handler reads it lazily and fails closed when it is absent.
  let broker: RuntimeWorkerOperationBroker | undefined;
  const workerId = randomUUID();
  const jobHandlers: Record<string, ModuleJobHandler> = {
    [MAIL_DELIVER_KIND]: createMailDeliverHandler(lazy),
    [INBOUND_DISPATCH_KIND]: createInboundDispatchHandler({
      broker: () => broker,
      workerId: () => workerId,
    }),
  };
  const module: RuntimeModule = {
    name: JOBS_PLUGIN,
    jobHandlers,
    workers: {
      [JOB_WORKER_ROLE]: {
        start(context) {
          const { db, log } = context;
          // Bound before the first poll, so no claim can run without it.
          broker = context.durableOperations;
          const mail = resolve();
          const handlers = composeJobHandlers([module, ...options.modules().filter((other) => other !== module)]);
          log.info(
            {
              worker: JOB_WORKER_ROLE, kinds: [...handlers.keys()].sort(), mail: mail.name,
              durableDispatch: broker ? "available" : "unavailable",
            },
            "Draining platform.jobs.",
          );
          return startJobWorker(db, handlers, log, readJobWorkerOptions(env));
        },
        // Core's own durable work store: the inbound delivery receipts
        // (jobs/inbound/work.ts). `roles/worker.ts` binds these into
        // `configuredDurableWorkerBroker`, which is what the handler above
        // then receives as `context.durableOperations`. All three together or
        // none — the worker role refuses a resolver without a pin, and a host
        // that cannot authorize a machine dispatch must still drain its queue.
        ...(durableDispatchConfigured(env)
          ? {
              // The keyring opens the sealed delivery payload; read per call,
              // so a rotation needs no worker restart and an absent keyring is
              // a retryable answer rather than a start-up failure.
              resolveOperationWork: (context, reference) =>
                resolveInboundOperationWork(
                  context.db, () => keyringFromEnv(env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS),
                )(reference),
              pinOperationContract: (context, reference, fingerprint) =>
                pinInboundOperationContract(context.db)(reference, fingerprint),
              markOperationDispatch: (context, reference, state) =>
                markInboundOperationDispatch(context.db)(reference, state),
            }
          : {}),
      },
    },
  };
  return module;
}
