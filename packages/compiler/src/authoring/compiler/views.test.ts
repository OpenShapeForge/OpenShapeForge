// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { buildViews } from "./views.js";

test("rejects an undeclared component in a view field override", () => {
  const entity = {
    description: "Test entity",
    ui: {
      presentations: {
        detail: {
          type: "detail",
          header: { title: "Test entity" },
          groups: [{ id: "main", fields: [{ key: "startsAt", render: { component: "DateTimePicker" } }] }],
        },
      },
    },
  };
  const catalog = { defaults: {}, viewDefaults: {}, components: { FieldDateAndTime: { kind: "field", description: "Date and time.", props: [] } } };

  expect(() => buildViews(entity as never, [], catalog as never)).toThrow(
    "startsAt: unknown presentation component DateTimePicker.",
  );
});
