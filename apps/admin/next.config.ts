// SPDX-License-Identifier: BUSL-1.1
import type { NextConfig } from "next";
import { validateProductionEnv } from "./src/lib/auth/validate-env";

const nextConfig: NextConfig = {
  output: "standalone",
  // Both workspace packages ship TypeScript source rather than a published
  // build, so Next has to compile them itself. Same list as apps/web.
  transpilePackages: ["@openshapeforge/auth", "@openshapeforge/ui"],
  // NOTE the deliberate difference from apps/web, which sets
  // `typescript: { ignoreBuildErrors: true }`. That is justified there because
  // most of apps/web is compiler output, so a type error is fixed in
  // packages/compiler and blocking the app build on it wedges the wrong repo.
  //
  // Nothing under apps/admin is generated — every file here is hand-written and
  // owned by this app — so there is no such escape hatch to preserve, and
  // `build:admin` is a second, independent type gate on top of
  // `typecheck:admin`. Do not copy apps/web's flag over without a reason.
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
