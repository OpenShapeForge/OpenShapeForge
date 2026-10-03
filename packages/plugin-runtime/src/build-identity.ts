// SPDX-License-Identifier: BUSL-1.1
import { readFileSync } from "node:fs";

export type BuildIdentity = Readonly<{
  release: string;
  build: string;
  version: string;
}>;

/** A deployment fact, independent of protocol and generated-schema versions. */
export function buildIdentity(release: string, build: string): BuildIdentity {
  if (typeof release !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release)) {
    throw new Error("Invalid software release version.");
  }
  if (typeof build !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/.test(build)) {
    throw new Error("Invalid software build identity.");
  }
  return Object.freeze({ release, build, version: `${release}+${build}` });
}

export function readBuildIdentity(
  env: Record<string, string | undefined> = process.env,
  fallbackRelease?: string,
): BuildIdentity {
  const file = env.OPENSHAPEFORGE_BUILD_IDENTITY_FILE;
  if (file) {
    const value = JSON.parse(readFileSync(file, "utf8")) as BuildIdentity;
    const identity = buildIdentity(value.release, value.build);
    if (value.version !== identity.version) throw new Error("Inconsistent software build identity.");
    return identity;
  }
  return buildIdentity(
    env.OPENSHAPEFORGE_BUILD_RELEASE ?? fallbackRelease ?? "0.0.0",
    env.OPENSHAPEFORGE_BUILD_REVISION ?? "unknown",
  );
}
