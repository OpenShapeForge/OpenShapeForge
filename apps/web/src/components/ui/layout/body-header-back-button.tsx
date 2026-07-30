// SPDX-License-Identifier: BUSL-1.1
"use client";

import { ChevronLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@openshapeforge/ui/button";

type BodyHeaderBackButtonProps = {
  fallbackHref?: string;
  label?: string;
};

export function BodyHeaderBackButton({
  fallbackHref = "/",
  label = "Ga terug",
}: BodyHeaderBackButtonProps) {
  const router = useRouter();

  function handleClick() {
    if (window.history.length > 1) {
      router.back();
      return;
    }

    router.push(fallbackHref);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="mt-0.5 shrink-0"
      onClick={handleClick}
      aria-label={label}
      title={label}
    >
      <ChevronLeft className="size-4" />
    </Button>
  );
}
