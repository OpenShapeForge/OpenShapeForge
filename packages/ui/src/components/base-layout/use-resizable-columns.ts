// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import {
  buildResizableColumnWidths,
  resizeResizableColumnWidths,
  scaleResizableColumnWidths,
} from "../../lib/resizable-columns";
import type { LayoutColumn } from "./types";

const RESIZE_GUTTER_WIDTH = 0;

type UseResizableColumnsOptions = {
  columns: LayoutColumn[];
  effectiveStorageKey: string | null;
  resizable: boolean;
  sizingSignature: string;
};

type UseResizableColumnsResult = {
  columnWidths: number[] | null;
  handleResizeKeyDown: (
    handleIndex: number,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
  handleResizeStart: (
    handleIndex: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => void;
  rowRef: RefObject<HTMLDivElement | null>;
  rowWidth: number;
};

function loadPersistedWidths(key: string, expectedLength: number): number[] | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === expectedLength &&
      parsed.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      return parsed as number[];
    }
  } catch {
    // Ignore malformed or unavailable storage.
  }

  return null;
}

function persistWidths(key: string, widths: number[]) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(widths));
  } catch {
    // Ignore quota and privacy-mode failures.
  }
}

export function useResizableColumns({
  columns,
  effectiveStorageKey,
  resizable,
  sizingSignature,
}: UseResizableColumnsOptions): UseResizableColumnsResult {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [rowWidth, setRowWidth] = useState(0);
  const [columnWidths, setColumnWidths] = useState<number[] | null>(null);
  const latestColumnWidthsRef = useRef<number[] | null>(null);
  const userResizedRef = useRef(false);
  const persistedLoadedRef = useRef(false);

  useEffect(() => {
    latestColumnWidthsRef.current = columnWidths;
  }, [columnWidths]);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) {
      return;
    }

    if (typeof ResizeObserver === "undefined") {
      setRowWidth(row.getBoundingClientRect().width);
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setRowWidth(entry.contentRect.width);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    userResizedRef.current = false;
    persistedLoadedRef.current = false;
  }, [sizingSignature]);

  useLayoutEffect(() => {
    persistedLoadedRef.current = false;
    userResizedRef.current = false;
  }, [effectiveStorageKey]);

  useLayoutEffect(() => {
    if (!resizable || rowWidth <= 0 || columns.length <= 1) {
      return;
    }

    const sizings = columns.map((column) => column.sizing);

    let storedWidths: number[] | null = null;
    if (!persistedLoadedRef.current) {
      persistedLoadedRef.current = true;
      storedWidths = effectiveStorageKey
        ? loadPersistedWidths(effectiveStorageKey, columns.length)
        : null;
    }

    setColumnWidths((current) => {
      if (current && current.length === columns.length && userResizedRef.current) {
        const next = scaleResizableColumnWidths(
          current,
          rowWidth,
          sizings,
          RESIZE_GUTTER_WIDTH,
        );
        if (
          current.length === next.length &&
          current.every((width, index) => Math.abs(width - next[index]) < 0.5)
        ) {
          return current;
        }
        return next;
      }

      if (storedWidths) {
        userResizedRef.current = true;
        return scaleResizableColumnWidths(
          storedWidths,
          rowWidth,
          sizings,
          RESIZE_GUTTER_WIDTH,
        );
      }

      return buildResizableColumnWidths(rowWidth, sizings, RESIZE_GUTTER_WIDTH);
    });
  }, [columns, effectiveStorageKey, resizable, rowWidth, sizingSignature]);

  function handleResizeStart(
    handleIndex: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (!resizable || !columnWidths || columnWidths.length !== columns.length) {
      return;
    }

    event.preventDefault();
    userResizedRef.current = true;

    const startX = event.clientX;
    const startingWidths = [...columnWidths];
    const sizings = columns.map((column) => column.sizing);

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(moveEvent: PointerEvent) {
      const delta = moveEvent.clientX - startX;
      const nextWidths = resizeResizableColumnWidths(
        startingWidths,
        sizings,
        handleIndex,
        delta,
      );
      latestColumnWidthsRef.current = nextWidths;
      setColumnWidths(nextWidths);
    }

    function onUp() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);

      const widths = latestColumnWidthsRef.current;
      if (widths && effectiveStorageKey) {
        persistWidths(effectiveStorageKey, widths);
      }
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
  }

  function handleResizeKeyDown(
    handleIndex: number,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    if (!resizable || !columnWidths || columnWidths.length !== columns.length) {
      return;
    }

    const step = event.shiftKey ? 64 : 16;
    const deltaByKey: Partial<Record<string, number>> = {
      ArrowLeft: -step,
      ArrowRight: step,
    };
    const delta = deltaByKey[event.key];

    if (delta === undefined) {
      return;
    }

    event.preventDefault();
    userResizedRef.current = true;

    const nextWidths = resizeResizableColumnWidths(
      columnWidths,
      columns.map((column) => column.sizing),
      handleIndex,
      delta,
    );
    latestColumnWidthsRef.current = nextWidths;
    setColumnWidths(nextWidths);

    if (effectiveStorageKey) {
      persistWidths(effectiveStorageKey, nextWidths);
    }
  }

  return {
    columnWidths,
    handleResizeKeyDown,
    handleResizeStart,
    rowRef,
    rowWidth,
  };
}
