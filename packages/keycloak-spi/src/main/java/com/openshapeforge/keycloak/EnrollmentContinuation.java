package com.openshapeforge.keycloak;

import java.net.URI;
import java.util.List;
import org.keycloak.authentication.RequiredActionContext;
import org.keycloak.models.Constants;
import org.keycloak.models.OrganizationModel;
import org.keycloak.organization.OrganizationProvider;
import org.keycloak.services.managers.AuthenticationManager;

/** Complete a detached enrollment only after native WebAuthn validation succeeds. */
final class EnrollmentContinuation {
    static final String RETURN_ORIGIN = "osf.passkey-enrollment-return-origin";

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
