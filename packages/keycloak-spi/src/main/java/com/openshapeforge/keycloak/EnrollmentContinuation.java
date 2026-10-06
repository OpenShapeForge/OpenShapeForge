// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import java.net.URI;
import java.util.List;
import org.keycloak.authentication.RequiredActionContext;
import org.keycloak.models.Constants;
import org.keycloak.models.OrganizationModel;
import org.keycloak.models.UserSessionModel;
import org.keycloak.organization.OrganizationProvider;
import org.keycloak.services.managers.AuthenticationManager;

/** Complete a detached enrollment only after native WebAuthn validation succeeds. */
final class EnrollmentContinuation {
    static final String RETURN_ORIGIN = "osf.passkey-enrollment-return-origin";

    /** Replace only this browser's old SSO session after native enrollment succeeds. */
    static void replaceBrowserSession(RequiredActionContext context) {
        var old = browserSessionToReplace(context);
        if (old == null) return;
        AuthenticationManager.backchannelLogout(context.getSession(), old, true);
        AuthenticationManager.expireIdentityCookie(context.getSession());
        var auth = context.getAuthenticationSession();
        var target = context.getSession().getProvider(OrganizationProvider.class).getByMember(context.getUser())
                .filter(OrganizationModel::isEnabled).findFirst().orElseThrow().getRedirectUrl();
        // Finish native required actions (including one-use token invalidation),
        // but never create another user's SSO session under the old session ID.
        auth.setAuthNote(AuthenticationManager.END_AFTER_REQUIRED_ACTIONS, "true");
        auth.setAuthNote(AuthenticationManager.SET_REDIRECT_URI_AFTER_REQUIRED_ACTIONS, "true");
        auth.setRedirectUri(target + "?account_changed=1");
    }

    static UserSessionModel browserSessionToReplace(RequiredActionContext context) {
        if (!Constants.ACCOUNT_MANAGEMENT_CLIENT_ID.equals(context.getAuthenticationSession().getClient().getClientId())) return null;
        if (context.getStatus() != RequiredActionContext.Status.SUCCESS
                || !context.getUser().isEnabled()) return null;
        var session = context.getSession();
        var realm = context.getRealm();
        var account = realm.getClientByClientId(Constants.ACCOUNT_MANAGEMENT_CLIENT_ID);
        String origin = account == null ? null : account.getAttribute(RETURN_ORIGIN);
        var provider = session.getProvider(OrganizationProvider.class);
        if (origin == null || provider == null) return null;
        var organizations = provider.getByMember(context.getUser())
                .filter(OrganizationModel::isEnabled).limit(2).toList();
        if (organizations.size() != 1 || !allowedTarget(origin, organizations.get(0).getRedirectUrl())) return null;
        var auth = context.getAuthenticationSession();
        var old = session.sessions().getUserSession(realm, auth.getParentSession().getId());
        if (old == null || old.getUser() == null || old.getUser().getId().equals(context.getUser().getId())) return null;
        // Native logout revokes this SSO session and its client sessions. Other
        // browser/device sessions are never enumerated or removed.
        return old;
    }

    static void resume(RequiredActionContext context) {
        var auth = context.getAuthenticationSession();
        if (context.getStatus() != RequiredActionContext.Status.SUCCESS
                || !context.getUser().isEnabled() || !context.getUser().isEmailVerified()
                || !Constants.ACCOUNT_MANAGEMENT_CLIENT_ID.equals(auth.getClient().getClientId())
                || !"true".equals(auth.getAuthNote(AuthenticationManager.END_AFTER_REQUIRED_ACTIONS))) return;
        String origin = auth.getClient().getAttribute(RETURN_ORIGIN);
        if (origin == null) return; // Other realms retain Keycloak's stock behavior.
        var provider = context.getSession().getProvider(OrganizationProvider.class);
        if (provider == null) return;
        List<OrganizationModel> memberships = provider.getByMember(context.getUser())
                .filter(OrganizationModel::isEnabled).limit(2).toList();
        if (memberships.size() != 1) return; // Never guess an organization.
        String target = memberships.get(0).getRedirectUrl();
        if (!allowedTarget(origin, target)) return;
        // Normal required-action completion now creates the native SSO session.
        // The host application starts its own OIDC/PKCE exchange when this return URL loads.
        auth.setRedirectUri(target);
        auth.removeAuthNote(AuthenticationManager.END_AFTER_REQUIRED_ACTIONS);
    }

    static boolean allowedTarget(String origin, String target) {
        try {
            URI base = URI.create(origin), destination = URI.create(target);
            boolean secure = "https".equals(base.getScheme()) || ("http".equals(base.getScheme())
                    && ("localhost".equals(base.getHost()) || "127.0.0.1".equals(base.getHost())));
            return secure && base.getHost() != null && base.getUserInfo() == null
                    && (base.getRawPath().isEmpty() || "/".equals(base.getRawPath()))
                    && base.getRawQuery() == null && base.getRawFragment() == null
                    && base.getScheme().equals(destination.getScheme())
                    && base.getRawAuthority().equals(destination.getRawAuthority())
                    && destination.getUserInfo() == null && destination.getRawFragment() == null
                    && destination.getRawQuery() == null;
        } catch (IllegalArgumentException | NullPointerException invalid) { return false; }
    }
}
