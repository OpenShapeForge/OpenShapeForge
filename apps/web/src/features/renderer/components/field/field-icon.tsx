// SPDX-License-Identifier: BUSL-1.1
/**
 * `<FieldIcon name="AtSign" />` — renders a lucide-react icon by name.
 *
 * The set of supported names is the union of:
 *  - `SemanticTypeDefinition.icon` values used in
 *    `packages/compiler/config/authoring/**\/semantic-types.yaml`
 *  - `FIELD_TYPE_ICONS` in `runtime/field-icons.ts`
 *
 * If the requested icon isn't in the registry, the component renders nothing.
 * Add new icons to {@link ICON_REGISTRY} when extending the catalog.
 */
import {
  AtSign,
  BadgeCheck,
  Banknote,
  Braces,
  Briefcase,
  Building2,
  Calendar,
  CalendarClock,
  CreditCard,
  Database,
  Fingerprint,
  GitBranch,
  Hash,
  Heart,
  Home,
  IdCard,
  Layers,
  Link,
  Link2,
  List,
  ListChecks,
  MapPin,
  MessageSquare,
  MousePointerClick,
  Phone,
  ToggleLeft,
  Type,
  Users,
} from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const ICON_REGISTRY = {
  AtSign,
  BadgeCheck,
  Banknote,
  Braces,
  Briefcase,
  Building2,
  Calendar,
  CalendarClock,
  CreditCard,
  Database,
  Fingerprint,
  GitBranch,
  Hash,
  Heart,
  Home,
  IdCard,
  Layers,
  Link,
  Link2,
  List,
  ListChecks,
  MapPin,
  MessageSquare,
  MousePointerClick,
  Phone,
  ToggleLeft,
  Type,
  Users,
} as const satisfies Record<string, React.ComponentType<{ className?: string }>>;

export type FieldIconName = keyof typeof ICON_REGISTRY;

type FieldIconProps = Omit<ComponentProps<"svg">, "name"> & {
  name: string | null | undefined;
};

export function FieldIcon({ name, className, ...rest }: FieldIconProps) {
  if (!name) return null;
  if (!(name in ICON_REGISTRY)) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(
        `FieldIcon: unknown icon name "${name}". Add it to ICON_REGISTRY in field-icon.tsx, or update the YAML to use a registered icon.`,
      );
    }
    return null;
  }
  const Icon = ICON_REGISTRY[name as FieldIconName];
  return <Icon className={cn("size-4", className)} {...rest} />;
}
