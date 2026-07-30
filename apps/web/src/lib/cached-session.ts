// SPDX-License-Identifier: BUSL-1.1
import "server-only";

import { cache } from "react";
import { auth } from "@/lib/auth";

/**
 * Deduplicate session resolution during a single server render pass.
 *
 * Generated pages, layouts, and server helpers often need the same session
 * data multiple times. Wrapping auth() in React.cache() keeps that work to a
 * single lookup per request.
 */
export const getCachedSession = cache(async () => auth());
