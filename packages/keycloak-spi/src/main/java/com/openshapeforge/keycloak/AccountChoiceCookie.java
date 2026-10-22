// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import jakarta.ws.rs.core.Response;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationProcessor;
import org.keycloak.authentication.authenticators.browser.CookieAuthenticator;
import org.keycloak.locale.LocaleSelectorProvider;
import org.keycloak.protocol.oidc.OIDCLoginProtocol;
import org.keycloak.services.managers.AuthenticationManager;
import org.keycloak.services.util.AuthenticationFlowURLHelper;
import org.keycloak.util.TokenUtil;

/** Native cookie SSO, except an explicit OIDC account choice must not reuse it. */
public final class AccountChoiceCookie extends CookieAuthenticator {
    @Override public void authenticate(AuthenticationFlowContext context) {
        var auth = context.getAuthenticationSession();
        if (!OIDCLoginProtocol.LOGIN_PROTOCOL.equals(auth.getProtocol())
                || !TokenUtil.hasPrompt(auth.getClientNote(OIDCLoginProtocol.PROMPT_PARAM),
                    OIDCLoginProtocol.PROMPT_VALUE_SELECT_ACCOUNT)) {
            super.authenticate(context);
            return;
        }
        // Clear only this realm's browser pointer. Native completion otherwise
        // removes the session referenced by the old identity cookie. Existing
        // access/refresh sessions remain server-side and usable by their apps.
        AuthenticationManager.expireIdentityCookie(context.getSession());
        // Native completion uses the root authentication-session id to find an
        // existing SSO session. Detach this request before a different person
        // authenticates; leave the previous user and all their clients intact.
        var previous = context.getSession().sessions().getUserSession(context.getRealm(), auth.getParentSession().getId());
        if (previous != null) {
            String locale = auth.getAuthNote(LocaleSelectorProvider.USER_REQUEST_LOCALE);
            var next = AuthenticationProcessor.recreate(context.getSession(), auth);
            AuthenticationProcessor.resetFlow(next, context.getFlowPath());
            if (locale != null) next.setAuthNote(LocaleSelectorProvider.USER_REQUEST_LOCALE, locale);
            var target = new AuthenticationFlowURLHelper(context.getSession(), context.getRealm(), context.getUriInfo())
                    .getLastExecutionUrl(next);
            context.forceChallenge(Response.seeOther(target).build());
            return;
        }
        // No person is inferred from the cookie. Native username and passkey
        // steps, required actions, consent and token validation still run.
        context.attempted();
    }
}
