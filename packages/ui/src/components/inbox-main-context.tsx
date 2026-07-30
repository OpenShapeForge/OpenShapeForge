// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { BaseLayoutProps, BaseLayoutTab } from "./base-layout";
import { BaseLayout } from "./base-layout";

export type InboxMainContextTab = BaseLayoutTab;

export type InboxMainContextProps = Omit<BaseLayoutProps, "variant">;

/**
 * Battery `inbox-main-context` — compatibility wrapper around `BaseLayout`.
 *
 * Figma specifies the reference frame at 1920×1080. Runtime sizing is fluid:
 * the shell fills its parent and the parent owns viewport/page height.
 *
 * @figma node-id=77-2068 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=77-2068
 */
export function InboxMainContext({
  "data-slot": dataSlot = "inbox-main-context",
  ...props
}: InboxMainContextProps) {
  return <BaseLayout {...props} data-slot={dataSlot} variant="inbox-main-context" />;
}
