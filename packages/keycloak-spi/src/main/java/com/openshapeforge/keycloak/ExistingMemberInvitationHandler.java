// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import java.net.URI;
import jakarta.ws.rs.core.Response;
import org.keycloak.authentication.actiontoken.ActionTokenContext;
import org.keycloak.authentication.actiontoken.inviteorg.InviteOrgActionToken;
import org.keycloak.authentication.actiontoken.inviteorg.InviteOrgActionTokenHandler;
import org.keycloak.events.Details;
import org.keycloak.events.EventType;
import org.keycloak.models.Constants;
import org.keycloak.models.OrganizationModel;
import org.keycloak.models.UserModel;
import org.keycloak.organization.OrganizationProvider;
import org.keycloak.organization.utils.Organizations;

/** Native token validation, with a normal app return for an existing member. */
public final class ExistingMemberInvitationHandler extends InviteOrgActionTokenHandler {
    @Override public int order() { return 10; }

    @Override public Response handleToken(InviteOrgActionToken token, ActionTokenContext<InviteOrgActionToken> context) {
        // Keycloak's signature, expiry, invitation and email verifiers run before
        // this method. Never replace preHandleToken or the native verifiers.
        var session = context.getSession();
        if (!Organizations.isEnabled(session)) return super.handleToken(token, context);
        var provider = session.getProvider(OrganizationProvider.class);
        var organization = provider.getById(token.getOrgId());
        var user = context.getAuthenticationSession().getAuthenticatedUser();
        var account = context.getRealm().getClientByClientId(Constants.ACCOUNT_MANAGEMENT_CLIENT_ID);
        String origin = account == null ? null : account.getAttribute(EnrollmentContinuation.RETURN_ORIGIN);
        String target = existingMemberTarget(origin, organization, user);
        if (target == null) return super.handleToken(token, context);
        // Native continuation may tolerate a missing record when an auth note
        // exists; a direct app return always requires a currently live record.
        var invitation = provider.getInvitationManager().getById(token.getId());
        if (invitation == null || invitation.isExpired()) return super.handleToken(token, context);

        if (!provider.getInvitationManager().remove(token.getId())) return super.handleToken(token, context);
        // Keycloak's verifier matched the token's address to this user, and the
        // token only reached them through that mailbox: the address is proven.
        // An unverified member used to fall through to "already a member" here,
        // with no way left to finish setting up the account.
        if (!user.isEmailVerified()) user.setEmailVerified(true);
        user.removeRequiredAction(UserModel.RequiredAction.VERIFY_EMAIL);
        context.getEvent().event(EventType.INVITE_ORG).detail(Details.ORG_ID, organization.getId())
                .detail(Details.USERNAME, user.getUsername())
                .detail("osf.invitation_outcome", "existing_member_return").success();
        // No membership, role or SSO session is created here.
        // The destination starts its normal login and checks current admission.
        return Response.seeOther(URI.create(target)).build();
    }

    static String existingMemberTarget(String origin, OrganizationModel organization, UserModel user) {
        if (organization == null || !organization.isEnabled() || user == null || !user.isEnabled()
                || !organization.isMember(user)) return null;
        String target = organization.getRedirectUrl();
        return EnrollmentContinuation.allowedTarget(origin, target) ? target : null;
    }
}
