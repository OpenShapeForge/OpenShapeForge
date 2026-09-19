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

/** SMTP when configured, otherwise the logging null provider — logged once at boot. */
export function configuredMailProvider(env: NodeJS.ProcessEnv = process.env): MailProvider {
  const smtp = readSmtpConfig(env);
  return smtp ? createSmtpMailProvider(smtp) : createNullMailProvider();
}

export type JobsRuntimeModuleOptions = {
  /** The other active modules; their `jobHandlers` join this module's. */
  modules: () => readonly RuntimeModule[];
  env?: NodeJS.ProcessEnv;
  mailProvider?: MailProvider;
};

export function createJobsRuntimeModule(options: JobsRuntimeModuleOptions): RuntimeModule {
  const env = options.env ?? process.env;
  const provider = options.mailProvider ?? configuredMailProvider(env);
  const jobHandlers: Record<string, ModuleJobHandler> = {
    [MAIL_DELIVER_KIND]: createMailDeliverHandler(provider),
  };
  const module: RuntimeModule = {
    name: JOBS_PLUGIN,
    jobHandlers,
    workers: {
      [JOB_WORKER_ROLE]: {
        start({ db, log }) {
          const handlers = composeJobHandlers([module, ...options.modules().filter((other) => other !== module)]);
          log.info(
            { worker: JOB_WORKER_ROLE, kinds: [...handlers.keys()].sort(), mail: provider.name },
            "Draining platform.jobs.",
          );
          return startJobWorker(db, handlers, log, readJobWorkerOptions(env));
        },
      },
    },
  };
  return module;
}
