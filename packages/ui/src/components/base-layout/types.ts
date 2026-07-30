// SPDX-License-Identifier: BUSL-1.1
import type {
  ComponentPropsWithoutRef,
  CSSProperties,
  ReactNode,
} from "react";

import type { ResizableColumnSizing } from "../../lib/resizable-columns";

export type BaseLayoutVariant =
  | "main"
  | "inbox-main"
  | "main-context"
  | "inbox-main-context";

export type BaseLayoutTab = {
  id: string;
  label: string;
  icon?: ReactNode;
  current?: boolean;
  closable?: boolean;
};

export type BaseLayoutColumnSize = {
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  weight?: number;
};

export type BaseLayoutProps = Omit<ComponentPropsWithoutRef<"div">, "children"> & {
  /** Figma component variant: `main`, `inbox-main`, `main-context` or `inbox-main-context`. */
  variant?: BaseLayoutVariant;
  /** Optional replacement for the collapsed `col-sidebar` rail. */
  sidebar?: ReactNode | false;
  /** Content for the fixed 280px inbox column. Rendered by `inbox-main` variants. */
  left?: ReactNode;
  /** Content for the flexible primary content column. Defaults to the Figma slot placeholder. */
  main?: ReactNode;
  /** Content for the fixed 400px context column. Rendered by `main-context` variants. */
  right?: ReactNode;
  /** Figma `tabs` property. Pass `false` to hide the top tab row. */
  tabs?: BaseLayoutTab[] | false;
  /** React-friendly alias for Figma `top-nav`. */
  topNav?: ReactNode | false;
  /** Figma `top-nav` property. Prefer `topNav` in TypeScript consumers. */
  "top-nav"?: ReactNode | false;
  /** Enables draggable column resize handles between the visible content columns. */
  resizable?: boolean;
  /** Optional sizing overrides for the 280px Figma inbox column. */
  leftSize?: BaseLayoutColumnSize;
  /** Optional sizing overrides for the flexible Figma main column. */
  mainSize?: BaseLayoutColumnSize;
  /** Optional sizing overrides for the 400px Figma context column. */
  rightSize?: BaseLayoutColumnSize;
  /** Optional class for the primary content column. */
  mainClassName?: string;
  /** Optional class for the left/inbox column. */
  leftClassName?: string;
  /** Optional class for the right/context column. */
  rightClassName?: string;
  /** Optional class for the content row containing the visible columns. */
  contentClassName?: string;
  /** Optional class for the inner card surface. */
  cardClassName?: string;
  /** localStorage namespace for persisted resized widths. Used only with `persistKey`. */
  storageKey?: string;
  /** Persist resized widths under `${storageKey}:${persistKey}` when provided. */
  persistKey?: string;
  /** Internal slot marker used by stories, tests and compatibility wrappers. */
  "data-slot"?: string;
};

export type LayoutColumnId = "left" | "main" | "right";

export type LayoutColumn = {
  id: LayoutColumnId;
  content: ReactNode;
  sizing: ResizableColumnSizing;
  className: string;
  element: "section" | "main" | "aside";
  ariaLabel?: string;
};

export type LayoutColumnStyle = CSSProperties;
