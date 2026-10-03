// SPDX-License-Identifier: BUSL-1.1
import { listInvitationRelations } from "./invitation-relations.js";
import * as roles from "./roles.js";
import * as custom from './custom-roles.js';
import * as members from './members.js';
import * as directory from './member-directory.js';
import * as memberActions from './member-actions.js';
import { inviteAccount } from "./invite.js";
import * as organizationDirectory from "./organization-directory.js";
import * as accountManagement from "./account-management.js";
import { blockAccountAvailability, restoreAccountAvailability, roleAccountAvailability } from "./account-availability.js";
import type {RuntimeModule} from '../modules/contract.js';
const module: RuntimeModule = { name: "accounts", operationHandlers: {
 listOrganizationAccounts:organizationDirectory.listOrganizationAccounts,getOrganizationAccount:organizationDirectory.getOrganizationAccount,
 blockOrganizationAccount:accountManagement.blockOrganizationAccount,restoreOrganizationAccount:accountManagement.restoreOrganizationAccount,
 assignOrganizationAccountRole:accountManagement.assignOrganizationAccountRole,revokeOrganizationAccountRole:accountManagement.revokeOrganizationAccountRole,
 listMembers:directory.listMembers,getMember:directory.getMember,addMemberGroup:members.addMemberGroup,removeMemberGroup:members.removeMemberGroup,
 listInvitationRelations,inviteMember:memberActions.inviteMember,requestMemberPasswordReset:memberActions.requestMemberPasswordReset,
 requestMemberPasskeyRecovery:memberActions.requestMemberPasskeyRecovery,resendMemberInvitation:memberActions.resendMemberInvitation,
 revokeMemberInvitation:memberActions.revokeMemberInvitation,listMemberAudit:memberActions.listMemberAudit,
 createRole:custom.createRole, listPermissions:custom.listPermissions, addRolePermission:custom.addRolePermission, removeRolePermission:custom.removeRolePermission, clearUnavailablePermissions:custom.clearUnavailablePermissions,
 inviteAccount,
 listRoles:roles.listRoles,getRole:roles.getRole,listGroupRoles:roles.listGroupRoles,getGroupRole:roles.getGroupRole,
 assignGroupRole:roles.assignGroupRole,revokeGroupRole:roles.revokeGroupRole
}, operationAvailabilityHandlers: {
  blockOrganizationAccount: blockAccountAvailability,
  restoreOrganizationAccount: restoreAccountAvailability,
  assignOrganizationAccountRole: roleAccountAvailability,
  revokeOrganizationAccountRole: roleAccountAvailability,
} };

export default module;
