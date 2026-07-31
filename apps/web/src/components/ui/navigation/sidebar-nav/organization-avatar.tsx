// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import { Avatar } from "@openshapeforge/ui";

type SidebarOrganization = {
  name: string;
  avatarStorageLocation?: string | null;
};

function organizationInitials(name: string): string {
  const words = name.split(" ").filter(Boolean);
  if (words.length >= 2) {
    return words.map((word) => word[0]).join("").toUpperCase().slice(0, 2);
  }
  return name.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 2) || "TN";
}

function storageLocationToDownloadUrl(storageLocation: string): string {
  return `/api/documents/download/${storageLocation
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

export function resolveOrganizationAvatar(organization?: SidebarOrganization): {
  organizationName: string;
  organizationAvatar: ReactNode;
} {
  const organizationName = organization?.name ?? "";
  const organizationAvatar = organizationName ? (
    organization?.avatarStorageLocation ? (
      <Avatar
        variant="avatar-square-image"
        src={storageLocationToDownloadUrl(organization.avatarStorageLocation)}
        alt={organizationName}
      />
    ) : (
      <Avatar variant="avatar-square-initial" initials={organizationInitials(organizationName)} />
    )
  ) : null;

  return { organizationName, organizationAvatar };
}
