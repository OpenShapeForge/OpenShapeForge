// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import org.keycloak.authentication.FormAction;
import org.keycloak.authentication.FormContext;
import org.keycloak.authentication.ValidationContext;
import org.keycloak.authentication.actiontoken.inviteorg.InviteOrgActionToken;
import org.keycloak.forms.login.LoginFormsProvider;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;

/** Registration from an organization invitation proves the address: the
 * signed invitation token was mailed to it, and Keycloak's own registration
 * step already refused any other address. Asking to verify it again only
 * adds a second mail that can be missed, which is how invitees got stuck. */
public final class InvitationEmailVerified implements FormAction {
    @Override public void success(FormContext context) {
        var token = (InviteOrgActionToken) context.getSession().getAttribute(InviteOrgActionToken.class.getName());
        if (markVerified(token, context.getUser()))
            context.getAuthenticationSession().setAuthNote(PasskeyOffer.ELIGIBLE, "true");
    }

    static boolean markVerified(InviteOrgActionToken token, UserModel user) {
        if (token == null || user == null || user.getEmail() == null || token.getEmail() == null
                || !token.getEmail().equalsIgnoreCase(user.getEmail())) return false;
        user.setEmailVerified(true);
        user.removeRequiredAction(UserModel.RequiredAction.VERIFY_EMAIL);
        return true;
    }

    @Override public void buildPage(FormContext context, LoginFormsProvider form) { }
    @Override public void validate(ValidationContext context) { context.success(); }
    @Override public boolean requiresUser() { return false; }
    @Override public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) { return true; }
    @Override public void setRequiredActions(KeycloakSession session, RealmModel realm, UserModel user) { }
    @Override public void close() { }
}
