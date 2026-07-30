// SPDX-License-Identifier: BUSL-1.1
import type { ColumnDef } from "@tanstack/react-table";
import type { TimelineEvent } from "@/lib/timeline-types";
import {
  ActivityCell,
  ActorCell,
  DomainCell,
  MomentCell,
} from "./timeline-cells";

export const TIMELINE_COLUMNS: ColumnDef<TimelineEvent>[] = [
  {
    id: "timestamp",
    header: "Moment",
    cell: ({ row }) => <MomentCell event={row.original} />,
    enableSorting: false,
    meta: {
      headerClassName: "w-[180px]",
      cellClassName: "w-[180px]",
    },
  },
  {
    id: "activity",
    header: "Activiteit",
    cell: ({ row }) => <ActivityCell event={row.original} />,
    enableSorting: false,
  },
  {
    id: "actor",
    header: "Door",
    cell: ({ row }) => <ActorCell event={row.original} />,
    enableSorting: false,
    meta: {
      headerClassName: "w-[200px]",
      cellClassName: "w-[200px]",
    },
  },
  {
    id: "domein",
    header: "Domein",
    cell: ({ row }) => <DomainCell event={row.original} />,
    enableSorting: false,
    meta: {
      headerClassName: "w-[180px]",
      cellClassName: "w-[180px]",
    },
  },
];
