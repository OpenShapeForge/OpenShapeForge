// SPDX-License-Identifier: BUSL-1.1
/**
 * The name the deployment calls itself where a person or a model reads it:
 * browser handoff pages, the upload tool's description, the name of the
 * gateway client in `whoami`. A host's word, so it comes from deployment
 * configuration beside the public origin, never from the engine's source.
 * Read per call so a test can set it and a composed host cannot cache it.
 */
export const PRODUCT_NAME_ENV = "OPENSHAPEFORGE_PRODUCT_NAME";

export const DEFAULT_PRODUCT_NAME = "OpenShapeForge";

export function productName(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env[PRODUCT_NAME_ENV]?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_PRODUCT_NAME;
}
