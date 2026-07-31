// SPDX-License-Identifier: BUSL-1.1
/**
 * Handing a claimed control command to an external durable-execution service.
 *
 * `control-command-worker.ts` owns the queue: it claims a row, calls a
 * dispatcher, and marks the row completed or failed. This module is one
 * dispatcher — the one that posts the command to a Restate ingress rather than
 * applying it in this process. The in-process dispatcher in that file is the
 * other, and the two are interchangeable by construction.
 *
 * ## What this buys, and what it does not
 *
 * It buys retry and serialization that outlive this process. Once the ingress
 * accepts the POST the invocation belongs to Restate: it is retried on
 * Restate's schedule whether or not the worker that posted it is still
 * running, and invocations sharing a key are serialized rather than raced. The
 * worker's own visibility timeout does the same job coarsely — wait out the
 * timeout, redispatch the whole command — so the two overlap rather than layer,
 * and this one simply reacts sooner and without the row having to be reclaimed.
 *
 * It does not buy correctness. The handler wraps the entire apply in a single
 * journalled step, so a retry re-runs the whole command; that is safe only
 * because the apply was already idempotent, and it was already idempotent
 * without any of this. `consumeRuntimeCommand` moves the command row out of
 * pending in a conditional update, and the instance row is taken `for update`
 * before anything is decided, so a duplicate delivery loses the consume and
 * returns without touching the run — whichever dispatcher produced it. That is
 * why the in-process path is sound, and why this module is an option rather
 * than a dependency.
 *
 * ## Keying
 *
 * The virtual-object key is the command id, so every delivery of one command
 * lands on one object and queues behind its predecessor instead of racing it.
 * The row's own `idempotency_key` is deliberately not used here: it
 * deduplicates at enqueue time, one layer up, and by the time a row has been
 * claimed the id is already the unique thing about it.
 *
 * ## Request shape
 *
 * The body is the claimed row — `commandId`, `tenantId`, `instanceId` and the
 * opaque `payload` — not a decoded command. Decoding belongs to the handlers in
 * `command-runtime.ts`, which are the same functions the in-process dispatcher
 * calls directly, so both paths read the payload under one set of rules and
 * cannot drift on what a field means or defaults to.
 */
import type {
  WorkflowControlCommandDispatcher,
  WorkflowRestateDispatchConfig,
} from "./control-command-worker.js";

/**
 * Command type to handler name on the virtual object. An unlisted type is an
 * error rather than a passthrough: the handler set is fixed at deploy time, so
 * a type with no handler here would fail at the ingress with a shape nobody can
 * act on, several seconds and one retry schedule later than it needs to.
 */
const COMMAND_HANDLERS: Record<string, string> = {
  "workflow.instance.start": "start",
  "workflow.instance.resume": "resume",
  "workflow.instance.cancel": "cancel",
};

export function createRestateWorkflowControlCommandDispatcher(
  config: WorkflowRestateDispatchConfig,
): WorkflowControlCommandDispatcher {
  return {
    dispatch: async (command) => {
      const handler = COMMAND_HANDLERS[command.commandType];
      if (!handler) {
        throw new Error(
          `Unsupported workflow control command type: ${command.commandType}`,
        );
      }

      const payload = command.payload;
      // The payload's own instance id wins over the column because a resume
      // enqueued against a child run carries the instance it is resuming, while
      // the column carries whatever the row was filed under.
      const instanceId =
        typeof payload.instanceId === "string"
          ? payload.instanceId
          : command.workflowInstanceId;
      if (!instanceId) {
        throw new Error(`${command.commandType} is missing instanceId.`);
      }

      await postRestate(config, {
        service: config.workflowCommandServiceName,
        key: command.id,
        handler,
        body: {
          commandId: command.id,
          tenantId: command.tenantId,
          instanceId,
          payload,
        },
      });
    },
  };
}

async function postRestate(
  config: WorkflowRestateDispatchConfig,
  input: {
    service: string;
    key: string | null;
    handler: string;
    body: Record<string, unknown>;
  },
) {
  const encodedService = encodeURIComponent(input.service);
  const encodedHandler = encodeURIComponent(input.handler);
  const url = input.key
    ? `${config.ingressUrl}/${encodedService}/${encodeURIComponent(input.key)}/${encodedHandler}`
    : `${config.ingressUrl}/${encodedService}/${encodedHandler}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input.body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `Restate dispatch failed (${response.status}): ${await response.text()}`,
    );
  }
}
