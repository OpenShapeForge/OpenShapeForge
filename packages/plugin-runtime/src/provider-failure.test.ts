// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { DECLARATIVE_PROVIDER_FAILURE } from "./index.js";

test("provider observations survive in-process envelope copies but never serialize", () => {
  const result = { error: { code: "provider_failure" }, [DECLARATIVE_PROVIDER_FAILURE]: { status: 404 } };
  expect({ ...result }[DECLARATIVE_PROVIDER_FAILURE]).toEqual({ status: 404 });
  expect(JSON.parse(JSON.stringify(result))).toEqual({ error: { code: "provider_failure" } });
});
