// SPDX-License-Identifier: BUSL-1.1
/** The isolated HTTP fixture has no Next router; the production guard only reads its pathname. */
export function usePathname(){return globalThis.location.pathname;}
