// SPDX-License-Identifier: BUSL-1.1
"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { Field } from "@/generated/compiler/field-contract";
import { getFieldSemanticTypeDefinition } from "@/lib/field-rendering/compiler-field-rendering";
import { useRemoteOptionSourceData } from "@/features/renderer/hooks/use-remote-options";
import { TextDisplay } from "@/features/renderer/display/text-display";

type WorkflowDefinitionOption = {
  value: string;
  label?: string | { nl?: string; en?: string };
  href?: string;
};

type WorkflowDefinitionReferenceDisplayProps = {
  field: Field;
  value: unknown;
  lang?: string;
};

function displayId(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function workflowLookupField(field: Field): Field {
  const semanticType = getFieldSemanticTypeDefinition(field);
  const remoteUrl =
    field.options?.type === "remote"
      ? field.options.remoteUrl
      : semanticType?.options?.type === "remote"
        ? semanticType.options.remoteUrl
        : semanticType?.listUrl;

  return remoteUrl
    ? {
        ...field,
        options: {
          type: "remote",
          remoteUrl,
        },
      }
    : field;
}

function resolveLabel(
  option: WorkflowDefinitionOption | null,
  id: string,
  lang: string,
) {
  const label = option?.label;
  if (typeof label === "string" && label.trim().length > 0) {
    return label.trim();
  }
  if (label && typeof label === "object") {
    return label[lang as "nl" | "en"] ?? label.nl ?? label.en ?? id;
  }
  return id;
}

export function WorkflowDefinitionReferenceDisplay({
  field,
  value,
  lang = "nl",
}: WorkflowDefinitionReferenceDisplayProps) {
  const id = displayId(value);
  const lookupField = workflowLookupField(field);
  const { data } = useRemoteOptionSourceData<WorkflowDefinitionOption[]>(
    lookupField,
    {
      enabled: id.length > 0,
      params: { id },
    },
  );

  if (!id) {
    return <TextDisplay>-</TextDisplay>;
  }

  const option = Array.isArray(data)
    ? (data.find((item) => item.value === id) ?? null)
    : null;
  const label = resolveLabel(option, id, lang);
  const href = option?.href ?? `/workflow-designer/${encodeURIComponent(id)}`;

  return (
    <Link
      href={href}
      className="inline-flex min-w-0 items-center gap-1 text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label={`${label} openen`}
    >
      <span className="truncate">{label}</span>
      <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
    </Link>
  );
}
