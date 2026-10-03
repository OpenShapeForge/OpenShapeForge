// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type {
  RuntimeModule,
  RuntimeOperationProvider,
} from "./index.js";

test("describes the portable runtime-module boundary", () => {
  const module = {
    name: "example",
    operationHandlers: {
      read: async () => ({ value: { id: "one" } }),
    },
  } satisfies RuntimeModule;

  expect(module.name).toBe("example");
});

test("describes host-started workers through the public module contract", async () => {
  const events: string[] = [];
  const module = {
    name: "worker-probe",
    workers: {
      probe: {
        start({ log }) {
          log.info({}, "started");
          events.push("start");
          return { stop: async () => void events.push("stop") };
        },
      },
    },
  } satisfies RuntimeModule;

  const handle = await module.workers.probe.start({
    db: {} as never,
    log: { info() {}, warn() {}, error() {} },
  });
  await handle.stop();
  expect(events).toEqual(["start", "stop"]);
});

test("describes record-derived Operations without transport-specific names", async () => {
  const provider = {
    id: "example.records",
    async list() {
      return [];
    },
    async get(_session, operationId) {
      return operationId === "example.record.invoke:one@1"
        ? {
            id: operationId,
            intent: "invoke",
            name: "Invoke record",
            description: "Invokes the published record.",
            input: { kind: "json-schema", schema: { type: "object" } },
            output: { kind: "json-schema", schema: {} },
            effects: { data: "read", external: "write" },
            reliability: { idempotency: { mode: "keyed" } },
            interaction: {
              secureInput: {
                type: "secureInput",
                sourceField: "adapterId",
                sourceEntity: "Adapter",
                definitionsField: "configurationFields",
                into: "configurationValues",
              },
            },
          }
        : undefined;
    },
    async execute() {
      return { data: { ok: true }, operations: [] };
    },
  } satisfies RuntimeOperationProvider;

  const module = {
    name: "example",
    operationProviders: [provider],
  } satisfies RuntimeModule;

  expect(module.operationProviders[0]?.id).toBe("example.records");
});
