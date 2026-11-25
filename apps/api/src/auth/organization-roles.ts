// SPDX-License-Identifier: BUSL-1.1
import { IDENTITY_CONTRACT } from "./identity-contract.js";

/**
 * Organization access administration permission from the compiled identity contract.
 * Keep this in a leaf module because invitations and identity linking import each other.
 */
export const IDENTITY_LINK_ADMIN_ROLE: string = IDENTITY_CONTRACT.administratorRole;
