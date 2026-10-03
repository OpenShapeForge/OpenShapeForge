// SPDX-License-Identifier: BUSL-1.1
import { readBuildIdentity } from "@openshapeforge/plugin-runtime/build-identity";
import apiPackage from "../../package.json" with { type: "json" };

export const API_BUILD_IDENTITY = readBuildIdentity(process.env, apiPackage.version);
