// SPDX-License-Identifier: BUSL-1.1
import { afterAll, describe, expect, it } from "bun:test";
import { executeBinding } from "../declarative-execution.js";

type SeenRequest = {
  method: string;
  path: string;
  ifMatch: string | null;
  body: unknown;
};

const seen: SeenRequest[] = [];
const provider = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const text = await request.text();
    seen.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      ifMatch: request.headers.get("if-match"),
      body: text ? JSON.parse(text) : undefined,
    });
    return Response.json({ accepted: true });
  },
});

afterAll(() => provider.stop(true));

describe("authored request headers over HTTP", () => {
  it("sends conditional update and delete requests with fixed If-Match targets", async () => {
    const providerRow = {
      transport: "rest",
      baseUrlTemplate: `http://127.0.0.1:${provider.port}`,
      egressHosts: ["127.0.0.1"],
    };
    const inputFields = [
      { key: "id", valueType: "string" },
      { key: "version", valueType: "string" },
      { key: "title", valueType: "string" },
    ];

    await executeBinding({
      binding: {},
      operationRow: {
        key: "update-record",
        operation: { method: "PATCH", pathTemplate: "/records/{id}" },
        inputFields,
        requestMapping: {
          headers: [{ field: "version", header: "If-Match" }],
          bodyPaths: [{ field: "title", path: "record.title" }],
        },
      },
      providerRow,
      connectionValues: {},
      serviceInputs: {
        id: "one",
        version: '"revision-one"',
        title: "Changed",
      },
      secretScope: "unused",
    });
    await executeBinding({
      binding: {},
      operationRow: {
        key: "delete-record",
        operation: { method: "DELETE", pathTemplate: "/records/{id}" },
        inputFields: inputFields.slice(0, 2),
        requestMapping: {
          headers: [{ field: "version", header: "If-Match" }],
        },
      },
      providerRow,
      connectionValues: {},
      serviceInputs: { id: "two", version: '"revision-two"' },
      secretScope: "unused",
    });

    expect(seen).toEqual([
      {
        method: "PATCH",
        path: "/records/one",
        ifMatch: '"revision-one"',
        body: { record: { title: "Changed" } },
      },
      {
        method: "DELETE",
        path: "/records/two",
        ifMatch: '"revision-two"',
        body: undefined,
      },
    ]);
  });
});
