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
  const url = resolveRemoteOptionSourceUrl(field, {
    params: options.params,
  });

  useEffect(() => {
    let active = true;

    if (!url || options.enabled === false) {
      setData(null);
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);

    loadRemoteJson<T>(url)
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
  }, [options.enabled, url]);

  return { data, loading, url };
}
