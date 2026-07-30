// SPDX-License-Identifier: BUSL-1.1
"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { Field } from "@/generated/compiler/field-contract";
import { getFieldSemanticTypeDefinition } from "@/lib/field-rendering/compiler-field-rendering";
import { useRemoteOptionSourceData } from "@/features/renderer/hooks/use-remote-options";
import { TextDisplay } from "@/features/renderer/display/text-display";

type EntityReferenceOption = {
  value: string;
  label?: {
    nl?: string;
    en?: string;
  };
  href?: string;
};

type EntityReferenceDisplayProps = {
  field: Field;
  value: unknown;
  lang?: string;
};

function displayValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function entityReferenceField(field: Field): Field {
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

export function EntityReferenceDisplay({
  field,
  value,
  lang = "nl",
}: EntityReferenceDisplayProps) {
  const id = displayValue(value);
  const lookupField = entityReferenceField(field);
  const { data, loading } = useRemoteOptionSourceData<EntityReferenceOption[]>(
    lookupField,
    {
      enabled: id.length > 0,
      params: {
        id,
        lang,
      },
    },
  );

  if (!id) {
    return <TextDisplay>-</TextDisplay>;
  }

  const option = Array.isArray(data) ? data.find((item) => item.value === id) : null;
  const label =
    option?.label?.[lang as "nl" | "en"] ??
    option?.label?.nl ??
    option?.label?.en ??
    (loading ? id : id);

  if (!option?.href) {
    return <TextDisplay>{label}</TextDisplay>;
  }

  return (
    <Link
      href={option.href}
      className="inline-flex min-w-0 items-center gap-1 text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label={`${label} openen`}
    >
      <span className="truncate">{label}</span>
      <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
    </Link>
  );
}
