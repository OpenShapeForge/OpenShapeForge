// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { moduleRealtimeAuthorizer, moduleRealtimeResources } from "./realtime-resources.js";
import type { ModulePlatformRuntime } from "./platform.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { getGeneratedCrudTables } from "../operations/entity/catalog.js";

test("realtime label paths require both valid locales at registration", () => {
  const resource = { entity: "PrivateFixture", readOperationId: "fixture.get", idInputField: "id" };
  for (const labelFields of [{ en: ["name"] }, { en: ["name"], nl: "name" }, { en: ["name"], nl: [42] }, null]) {
    expect(() => moduleRealtimeResources([{ name: "fixture", realtimeResources: [{ ...resource, labelFields }] }] as never)).toThrow();
  }
  expect(moduleRealtimeResources([{ name: "fixture", realtimeResources: [{ ...resource, labelFields: { en: ["name"], nl: ["details.name"] } }] }] as never).has("PrivateFixture")).toBe(true);
  expect(moduleRealtimeResources([{ name: "fixture", realtimeResources: [resource] }] as never).has("PrivateFixture")).toBe(true);
});

test("private realtime hints require the current canonical harmless read", async () => {
  const session = {
    tenantId: "tenant",
    userId: "subject",
  } as TrustedSessionContext;
  let seen: unknown;
  let allowed = true;
  let write = false;
  const platform = {
    withActiveOperationSession: async (
      live: unknown,
      work: (session: unknown) => unknown,
    ) => work(live),
    services: {
      operations: {
        get: async () =>
          allowed
            ? {
                id: "fixture.get",
                intent: "get",
                effects: { data: write ? "write" : "read", external: "none" },
              }
            : undefined,
        execute: async (live: unknown, request: unknown) => {
          seen = { live, request };
          return { data: { id: "record" }, operations: [] };
        },
      },
    },
  } as unknown as ModulePlatformRuntime;
  const authorize = moduleRealtimeAuthorizer(
    [
      {
        name: "fixture",
        realtimeResources: [
          {
            entity: "PrivateFixture",
            readOperationId: "fixture.get",
            idInputField: "recordId",
          },
        ],
      },
    ],
    platform,
  );
  expect(await authorize(session, "unknown", "record")).toBe(false);
  expect(seen).toBeUndefined();
  expect(await authorize(session, "PrivateFixture", "record")).toBe(true);
  expect(seen).toMatchObject({
    live: session,
    request: { input: { recordId: "record" } },
  });
  allowed = false;
  expect(await authorize(session, "PrivateFixture", "record")).toBe(false);
  allowed = true;
  write = true;
  expect(await authorize(session, "PrivateFixture", "record")).toBe(false);
});
test("a private resource cannot override generated Entity authorization", () => {
  const existing = getGeneratedCrudTables()[0]!.source!.authoringEntityName!;
  expect(() =>
    moduleRealtimeAuthorizer(
      [
        {
          name: "fixture",
          realtimeResources: [
            {
              entity: existing,
              readOperationId: "fixture.get",
              idInputField: "id",
            },
          ],
        },
      ],
      {} as ModulePlatformRuntime,
    ),
  ).toThrow();
});
