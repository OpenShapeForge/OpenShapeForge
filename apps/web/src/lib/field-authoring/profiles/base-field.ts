// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";

export function createBaseField(): Field {
  return {
    key: "",
    valueType: "string",
    cardinality: { min: 0, max: 1 },
    required: false,
    label: {
      nl: "",
      en: "",
    },
    description: {
      nl: "",
      en: "",
    },
    placeholder: {
      nl: "",
      en: "",
    },
    help: {
      nl: "",
      en: "",
    },
  };
}
