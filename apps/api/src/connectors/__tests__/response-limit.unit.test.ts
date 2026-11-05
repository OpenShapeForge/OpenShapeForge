// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { listConnectorContracts } from "../catalog.js";
import { loadConnectorPackages } from "../loader.js";
import { invokeOperation } from "../executor.js";

test.each([
  { slug: "exact-online", key: "getRecords", input: { endpoint: "crm/Accounts" }, config: { region: "nl", clientId: "client", division: 123456 }, secrets: { clientSecret: "secret" } },
  { slug: "afas-profit", key: "getConnector", input: { connectorId: "Profit_Debiteuren" }, config: { environmentId: "12345", environmentType: "production" }, secrets: { token: "dGVzdA==" } },
  { slug: "dynamics-finance", key: "getRecords", input: { entity: "CustomersV3" }, config: { environmentHost: "contoso.operations.dynamics.com", tenantId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", clientId: "client" }, secrets: { clientSecret: "secret" } },
  { slug: "twinfield", key: "listOffices", input: {}, config: { clusterHost: "accounting.twinfield.com", companyCode: "TEST001", clientId: "client" }, secrets: { clientSecret: "secret" } },
])("$slug rejects an oversized chunked provider response", async ({ slug, key, input, config, secrets }) => {
  const contract = listConnectorContracts().find((item) => item.slug === slug)!;
  const loaded = (await loadConnectorPackages([contract])).loaded.get(slug)!;
  const operation = contract.operations.find((item) => item.key === key)!;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  await expect(invokeOperation({
    contract, operation, pkg: loaded.pkg, boundary: loaded.boundary,
    input, config, secrets,
    fetchImpl: async () => new Response(body),
  })).rejects.toThrow(/exceeds the supported size/);
  expect(cancelled).toBe(true);
});
