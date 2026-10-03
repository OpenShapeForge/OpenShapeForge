// SPDX-License-Identifier: BUSL-1.1
// Compatibility path: packaged plugins and core share the identical primitive
// and ciphertext/AAD format. Do not fork encryption inside a runtime module.
export * from "@openshapeforge/plugin-runtime/secrets";
