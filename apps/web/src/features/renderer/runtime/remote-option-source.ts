// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import { getFieldSemanticTypeDefinition } from "@/lib/field-rendering/compiler-field-rendering";

export type RemoteOptionRequestParam =
  | string
  | number
  | boolean
  | null
  | undefined;

export type RemoteOptionRequestParams = Record<string, RemoteOptionRequestParam>;

function trimRemoteUrl(field: Field | null | undefined) {
  const options =
    field?.options ??
    getFieldSemanticTypeDefinition(field ?? {})?.options;

  if (options?.type !== "remote") {
    return null;
  }

  const remoteUrl = options.remoteUrl?.trim();
  return remoteUrl && remoteUrl.length > 0 ? remoteUrl : null;
}

export function resolveRemoteOptionSourceUrl(
  field: Field | null | undefined,
  options: {
    params?: RemoteOptionRequestParams;
    origin?: string;
  } = {},
) {
  const remoteUrl = trimRemoteUrl(field);
  if (!remoteUrl) {
    return null;
  }

  const origin =
    options.origin ??
    (typeof window !== "undefined" ? window.location.origin : "http://localhost");
  const url = new URL(remoteUrl, origin);

  for (const [key, rawValue] of Object.entries(options.params ?? {})) {
    if (rawValue == null) {
      continue;
    }

    const value = String(rawValue).trim();
    if (!value) {
      continue;
    }

    url.searchParams.set(key, value);
  }

  return url.toString();
}
