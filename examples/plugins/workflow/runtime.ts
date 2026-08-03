// SPDX-License-Identifier: BUSL-1.1
/**
 * The workflow plugin's runtime half.
 *
 * The compiler-side default export (`./index.ts`) contributes platform tables
 * and emits the catalog documents; this one is imported by the API at boot and
 * says what to do with them. The `name` must match the compiler plugin's — the
 * loader refuses the pair otherwise, because two halves that disagree are a
 * stale build rather than a configuration choice.
 *
 * Today it contributes only the catalog seeds, which the API previously called
 * directly. Moving them here is the point of the change: `apps/api` no longer
 * carries a hardcoded path to a plugin's generated output, and a repo that
 * drops the workflow plugin stops seeding without editing the migration chain.
 *
 * It also contributes the definition-authoring GraphQL surface — definitions,
 * versions, validation, patching, edit locks, and the node catalogs the designer
 * reads. Those are not generated CRUD on purpose: the tables are declared
 * `domainInternal`, because every invariant that makes a definition meaningful
 * (versioning, validate-on-publish, the edit lock, refusing to delete a
 * definition with runs) lives above the columns rather than in them.
 *
 * `restRoutes` mounts the inbound webhook trigger. The host calls it inside the
 * same child plugin the core routes use, so a contributed route sits behind the
 * rate limiter without asking — which matters most for the one route here,
 * since it is the only workflow surface an outside caller reaches directly.
 *
 * It also contributes the `workflow-worker` role — the process that drains the
 * control-command queue. That is contributed rather than hardcoded in
 * `apps/api/src/index.ts` for the same reason as everything else here: the API
 * should not know which workers exist any more than it knows which node types
 * do.
 */
import type { RuntimeModule } from "../../../apps/api/src/modules/contract.js";
import { applyWorkflowCatalogsSeed } from "../../../apps/api/src/db/migrations/workflow-catalogs-seed.js";
import {
  createWorkflowControlCommandDispatcher,
  readWorkflowRestateDispatchConfig,
  startWorkflowControlCommandWorker,
} from "./runtime/control-command-worker.js";
import {
  workflowMutationFields,
  workflowQueryFields,
  workflowResolvers,
  workflowTypeDefs,
} from "./runtime/graphql.js";
import { hydrateNodeCatalog } from "./runtime/node-catalog-store.js";
import { registerAllWorkflowNodeBridges } from "./runtime/node-bridges.js";
import { startWorkflowScheduleWorker } from "./runtime/schedule-worker.js";
import { startWorkflowTimerWaitWorker } from "./runtime/timer-waits.js";
import { registerWorkflowWebhookRoutes } from "./runtime/webhook-routes.js";
import { WORKFLOW_WORKER_ROLE } from "./worker-role.js";

const plugin: RuntimeModule = {
  name: "workflow",

  /**
   * Hydrate the node catalog before anything can be asked about it.
   *
   * Definition validation resolves node types through the catalog, and an
   * unhydrated store answers every lookup with nothing — which would make
   * validation pass while checking nothing at all. Failing here is a load
   * failure: the module is dropped and its surfaces are absent, which is the
   * honest outcome when it cannot answer correctly.
   */
  async init({ db }) {
    // Bridges first, and without a database: the registry is what decides
    // whether a node type can execute at all, and a deployment that cannot
    // reach Postgres should still be able to answer that question.
    registerAllWorkflowNodeBridges();
    if (!db) return; // no database configured; the surfaces degrade with it
    await hydrateNodeCatalog(db);
  },

  graphql() {
    return {
      typeDefs: workflowTypeDefs,
      queryFields: workflowQueryFields,
      mutationFields: workflowMutationFields,
      resolvers: workflowResolvers,
    };
  },

  /**
   * `POST /api/workflow/triggers/webhook/:definitionId` — the one workflow
   * surface reached from outside rather than through GraphQL.
   *
   * It is not anonymous: the handler resolves a session from the request
   * headers and refuses without a verified tenant and user, then the start
   * command applies the same writer-role check every other start path does. So
   * "webhook" here means an authenticated caller poking a definition, not an
   * arbitrary third party — there is no payload signature to verify because
   * there is no shared secret with a sender.
   *
   * `db` may be absent (the module contract lets a runtime boot without one);
   * the handler answers 503 rather than throwing, which is why it is passed
   * straight through instead of being guarded here.
   */
  restRoutes(routes, context) {
    registerWorkflowWebhookRoutes(routes, context);
  },

  /**
   * The `workflow-worker` role: one process draining `workflow.control_commands`.
   *
   * It runs here rather than alongside GraphQL because it is a poll loop with
   * its own failure modes, and because its database session is deliberately
   * different from a request's — it presents `app.worker_role`, which the three
   * queue tables' RLS policies name and the API's request path never sets.
   * `apps/api` does not know this role exists; a repo that drops the workflow
   * plugin loses it with the plugin.
   *
   * The schedule and timer workers run in this same role, because all three are
   * one pipeline. Neither of the other two touches a run directly: a due
   * schedule enqueues a `workflow.instance.start` command and a due timer
   * enqueues a `workflow.instance.resume`, and the control-command worker is
   * what drains both. Split across roles, a deployment could run half of that
   * and watch schedules fire and timers expire into a queue nothing reads.
   *
   * That is also why the timer is swept here rather than slept on. A deployment
   * may configure an external durable-execution service to dispatch commands,
   * and it offers a durable sleep — but it is optional, the two dispatchers are
   * interchangeable by construction, and a timer built on it would silently not
   * exist in the default deployment. The sweep decides only *when*; the resume
   * it enqueues is dispatched by whichever dispatcher is configured, so the two
   * compose rather than compete.
   *
   * All three are poll loops, so the role owns three intervals and stops them
   * all. `stop()` must settle only after each has finished its in-flight tick:
   * the schedule worker holds claimed `workflow.schedules` rows with `locked_by`
   * set, and the timer sweep may have claimed waits whose resume is not
   * enqueued yet — those runs would stay parked with `resumed_at` already
   * written, so nothing would ever sweep them again.
   */
  workers: {
    [WORKFLOW_WORKER_ROLE]: {
      start({ db, log }) {
        // Which dispatcher was chosen is worth one line at boot: in-process and
        // durable execution are both correct, and an operator who configured a
        // Restate ingress should be able to see that it took.
        const restate = readWorkflowRestateDispatchConfig();
        log.info(
          {
            worker: WORKFLOW_WORKER_ROLE,
            dispatch: restate ? "restate" : "in-process",
            ...(restate ? { service: restate.workflowCommandServiceName } : {}),
          },
          "Draining workflow.control_commands, firing due workflow.schedules and resuming due timer waits.",
        );

        const commands = startWorkflowControlCommandWorker(
          db,
          createWorkflowControlCommandDispatcher(db),
        );
        const schedules = startWorkflowScheduleWorker(db);
        const timers = startWorkflowTimerWaitWorker(db);

        return {
          stop: async () => {
            // Producers first, drain last: both enqueue commands, so stopping
            // them before the drain means the queue is not being refilled while
            // it empties. Sequential rather than Promise.all for that ordering
            // — none rejects, each only awaits its own tick.
            await schedules.stop();
            await timers.stop();
            await commands.stop();
          },
        };
      },
    },
  },

  seeds: [
    {
      name: "workflowCatalogs",
      // One reported result for the whole set: the three tables are filled from
      // four documents produced by one generator run, and a partial outcome is
      // not a state an operator can act on differently.
      apply: async (db) => {
        const result = await applyWorkflowCatalogsSeed(db);
        const parts = [result.nodeCatalogs, result.triggerRegistry, result.fieldSuggestions];
        return {
          present: parts.some((part) => part.present),
          skipped: parts.every((part) => part.skipped),
          rows: parts.reduce((total, part) => total + part.rows, 0),
        };
      },
    },
  ],
};

export default plugin;
