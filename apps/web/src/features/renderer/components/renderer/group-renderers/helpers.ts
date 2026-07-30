// SPDX-License-Identifier: BUSL-1.1
import type { RendererFormGroup } from "@/features/renderer/form-definition";
import { translateRendererText } from "@/features/renderer/runtime/field-utils";

export function getGroupTitle(group: RendererFormGroup, lang: string) {
  return translateRendererText(group.title ?? group.label, lang);
}
