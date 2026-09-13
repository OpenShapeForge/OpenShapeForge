// SPDX-License-Identifier: BUSL-1.1
export type RuntimeSettingValue = boolean | number | string | readonly string[] | null;

/** Read-only projection of the compiler's effective settings, without defaults. */
export type RuntimeSettingsService = Readonly<{
  get(key: string): RuntimeSettingValue | undefined;
  providerSupports(providerId: string, capability: string): boolean;
}>;
