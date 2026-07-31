// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import type { EntityManifestEntry } from "@/compiler/entity-manifest";

export type WorkspaceSearchParams = { [key: string]: string | string[] | undefined };

export type EntityWorkspacePageProps = {
  entry: EntityManifestEntry;
  config: any;
  lang: string;
  searchParams: WorkspaceSearchParams;
};

export type WorkspaceColumnSize = number | `${number}fr`;

export interface WorkspaceColumn {
  content: ReactNode;
  size: WorkspaceColumnSize;
  min?: number;
  max?: number;
}

export type WorkspaceListData = {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  totalCount?: number;
};

export type PageAction = {
  key: string;
  label: string;
  href?: string;
};
