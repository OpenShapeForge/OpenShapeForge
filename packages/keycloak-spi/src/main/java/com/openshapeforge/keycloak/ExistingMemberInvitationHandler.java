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
        var invitation = provider.getInvitationManager().getById(token.getId());
        if (target == null || invitation == null || invitation.isExpired()) return super.handleToken(token, context);

        provider.getInvitationManager().remove(token.getId());
        context.getEvent().event(EventType.INVITE_ORG).detail(Details.ORG_ID, organization.getId())
                .detail(Details.USERNAME, user.getUsername()).success();
        // No membership, role, required action or SSO session is created here.
        // The destination starts its normal login and checks current admission.
        return Response.seeOther(URI.create(target)).build();
    }

    static String existingMemberTarget(String origin, OrganizationModel organization, UserModel user) {
        if (organization == null || !organization.isEnabled() || user == null || !user.isEnabled()
                || !user.isEmailVerified() || !organization.isMember(user)) return null;
        String target = organization.getRedirectUrl();
        return EnrollmentContinuation.allowedTarget(origin, target) ? target : null;
    }
}
