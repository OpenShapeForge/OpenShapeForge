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
import type { ModuleJobHandler, RuntimeModule } from "../modules/contract.js";
import { composeJobHandlers } from "./handlers.js";
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
 * explicit `OPENSHAPEFORGE_MAIL_PROVIDER=null`, and never under
 * `NODE_ENV=production` — a production worker that quietly dropped every
 * message would be worse than one that did not start. Nothing else is a
 * configuration, so the worker refuses to start on it.
 */
export function configuredMailProvider(env: NodeJS.ProcessEnv = process.env): MailProvider {
  const smtp = readSmtpConfig(env);
  if (smtp) return createSmtpMailProvider(smtp);
  const selected = env[MAIL_PROVIDER_ENV]?.trim();
  if (selected === "null") {
    if (env.NODE_ENV === "production") {
      throw new Error(`${MAIL_PROVIDER_ENV}=null is a development setting; a production job-worker needs OPENSHAPEFORGE_SMTP_URL.`);
    }
    return createNullMailProvider();
  }
  if (selected) throw new Error(`${MAIL_PROVIDER_ENV} "${selected}" is unknown; set OPENSHAPEFORGE_SMTP_URL, or ${MAIL_PROVIDER_ENV}=null in development.`);
  throw new Error(`No mail transport is configured: set OPENSHAPEFORGE_SMTP_URL, or ${MAIL_PROVIDER_ENV}=null to log messages instead in development.`);
}

export type JobsRuntimeModuleOptions = {
  /** The other active modules; their `jobHandlers` join this module's. */
  modules: () => readonly RuntimeModule[];
  env?: NodeJS.ProcessEnv;
  mailProvider?: MailProvider;
};

export function createJobsRuntimeModule(options: JobsRuntimeModuleOptions): RuntimeModule {
  const env = options.env ?? process.env;
  // Resolved when the worker starts, not when the module is created: the API
  // process composes this module to validate the job kinds and never sends.
  let provider = options.mailProvider;
  const resolve = (): MailProvider => (provider ??= configuredMailProvider(env));
  const lazy: MailProvider = { get name() { return resolve().name; }, send: (message) => resolve().send(message) };
  const jobHandlers: Record<string, ModuleJobHandler> = {
    [MAIL_DELIVER_KIND]: createMailDeliverHandler(lazy),
  };
  const module: RuntimeModule = {
    name: JOBS_PLUGIN,
    jobHandlers,
    workers: {
      [JOB_WORKER_ROLE]: {
        start({ db, log }) {
          const mail = resolve();
          const handlers = composeJobHandlers([module, ...options.modules().filter((other) => other !== module)]);
          log.info(
            { worker: JOB_WORKER_ROLE, kinds: [...handlers.keys()].sort(), mail: mail.name },
            "Draining platform.jobs.",
          );
          return startJobWorker(db, handlers, log, readJobWorkerOptions(env));
        },
      },
    },
  };
  return module;
}
