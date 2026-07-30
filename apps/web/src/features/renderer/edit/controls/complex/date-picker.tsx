// SPDX-License-Identifier: BUSL-1.1
import type { ComponentProps } from "react";

import { Input } from "@/components/ui/forms/input";

function DatePicker(props: ComponentProps<typeof Input>) {
  return <Input {...props} type="date" />;
}

export { DatePicker };
