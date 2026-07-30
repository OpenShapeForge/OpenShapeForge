// SPDX-License-Identifier: BUSL-1.1
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Sidebar category label used to group navigation items.
 *
 * @figma sidebar-category — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=33-6580
 */
export interface SidebarCategoryProps extends HTMLAttributes<HTMLDivElement> {
  /** Category label text, usually already uppercase from navigation data. */
  children: ReactNode;
}

export function SidebarCategory({ children, className, ...props }: SidebarCategoryProps) {
  return (
    <div className={cn("flex items-center px-2 pt-4", className)} {...props}>
      <p className="font-sans text-[9px] font-normal uppercase leading-[10px] tracking-[-0.27px] text-muted-foreground">
        {children}
      </p>
    </div>
  );
}
