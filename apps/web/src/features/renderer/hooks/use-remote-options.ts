// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useState, useEffect } from "react";
import type { Field } from "@/generated/compiler/field-contract";
import type { StaticOption } from "@/features/renderer/runtime/options-utils";
import { loadRemoteJson } from "@/features/renderer/runtime/remote-json-cache";
import {
  resolveRemoteOptionSourceUrl,
  type RemoteOptionRequestParams,
} from "@/features/renderer/runtime/remote-option-source";
import { resolveEntityOptionSource } from "@/features/renderer/runtime/entity-option-source";
import { listEntityOptions } from "@/actions/entity-options";

export function useRemoteOptions(field: Field): {
  items: StaticOption[];
  loading: boolean;
} {
  const { data, loading } = useRemoteOptionSourceData<unknown>(field);

  return {
    items: Array.isArray(data) ? (data as StaticOption[]) : [],
    loading,
  };
}

export function useRemoteOptionSourceData<T>(
  field: Field | null | undefined,
  options: {
    params?: RemoteOptionRequestParams;
    enabled?: boolean;
  } = {},
): {
  data: T | null;
  loading: boolean;
  url: string | null;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  // An entity source lists the entity's records through the gateway; a remote
  // source fetches JSON from a declared endpoint. The picker asks the same way
  // for both: a search term, or one known value to name.
  const entity = resolveEntityOptionSource(field);
  const url = entity ? null : resolveRemoteOptionSourceUrl(field, { params: options.params });
  const params = options.params ?? {};
  const search = typeof params.search === "string" ? params.search : "";
  const id = typeof params.id === "string" ? params.id : "";
  const entityName = entity?.entity ?? null;
  const valueField = entity?.valueField ?? "id";

  useEffect(() => {
    let active = true;

    if ((!url && !entityName) || options.enabled === false) {
      setData(null);
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);

    const load = entityName
      ? listEntityOptions({ entity: entityName, valueField, search, id }) as Promise<T>
      : loadRemoteJson<T>(url!);
    load
      .then((nextData) => {
        if (active) {
          setData(nextData);
        }
      })
      .catch(() => {
        if (active) {
          setData(null);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [options.enabled, url, entityName, valueField, search, id]);

  return { data, loading, url };
}
