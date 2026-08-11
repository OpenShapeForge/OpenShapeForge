// SPDX-License-Identifier: BUSL-1.1
import type { NextConfig } from "next";
import { validateProductionEnv } from "./src/lib/auth/validate-env";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@openshapeforge/auth", "@openshapeforge/ui"],
  // TypeScript is validated separately via `bun run typecheck:web`. Next's
  // build-time check is redundant here and would block builds on errors in
  // compiler-generated pages, which are fixed in packages/compiler rather than
  // in this app.
  typescript: { ignoreBuildErrors: true },
};

export function createNextConfig(
  phase: string,
  env: Record<string, string | undefined> = process.env,
): NextConfig {
  validateProductionEnv({ ...env, NEXT_PHASE: phase });
  return nextConfig;
}

export default function configureNext(phase: string): NextConfig {
  return createNextConfig(phase);
}
