// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import jakarta.ws.rs.core.Response;
import java.util.function.Supplier;
import org.keycloak.OAuth2Constants;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.AuthenticationProcessor;
import org.keycloak.authentication.authenticators.broker.AbstractIdpAuthenticator;
import org.keycloak.authentication.authenticators.broker.util.SerializedBrokeredIdentityContext;
import org.keycloak.broker.provider.BrokeredIdentityContext;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.IdentityProviderModel;
import org.keycloak.locale.LocaleSelectorProvider;
import org.jboss.logging.Logger;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.services.resources.IdentityBrokerService;
import org.keycloak.services.resources.LoginActionsService;
import org.keycloak.sessions.AuthenticationSessionModel;

/** First-broker-login terminal: never create, link, or authenticate a user.
 * An explicit retry reuses native broker state validation and changes only
 * the upstream request's prompt, leaving the original client's request intact. */
public final class BrokerAccountRetry extends AbstractIdpAuthenticator {
    private static final Logger LOG = Logger.getLogger(BrokerAccountRetry.class);
    @Override protected void authenticateImpl(AuthenticationFlowContext context,
            SerializedBrokeredIdentityContext serialized, BrokeredIdentityContext broker) {
        if (!supported(broker.getIdpConfig())) { unsupported(context, broker.getIdpConfig()); return; }
        context.challenge(context.form().setAttribute("brokerAccount", broker.getUsername())
            .createForm("broker-account-retry.ftl"));
    }

    @Override protected void actionImpl(AuthenticationFlowContext context,
            SerializedBrokeredIdentityContext serialized, BrokeredIdentityContext broker) {
        var form = context.getHttpRequest().getDecodedFormParameters();
        if (form.containsKey("cancel")) { context.cancelLogin(); return; }
        if (!"true".equals(form.getFirst("retry"))) {
            context.failure(AuthenticationFlowError.ACCESS_DENIED); return;
        }
        if (!supported(broker.getIdpConfig())) { unsupported(context, broker.getIdpConfig()); return; }
        try {
            var service = new IdentityBrokerService(context.getSession());
            service.init();
            var provider = IdentityBrokerService.getIdentityProvider(context.getSession(), broker.getIdpConfig().getAlias());
            context.forceChallenge(reauthenticate(context.getAuthenticationSession(),
                () -> service.retryLogin(provider, context.getAuthenticationSession())));
        } catch (RuntimeException error) {
            LOG.warnf("Unable to start broker account retry for provider %s (%s)",
                broker.getIdpConfig().getAlias(), error.getClass().getSimpleName());
            context.failure(AuthenticationFlowError.ACCESS_DENIED);
        }
    }

    static boolean supported(IdentityProviderModel provider) {
        return provider.isEnabled() && "oidc".equals(provider.getProviderId())
            && (provider.getConfig().get("prompt") == null || provider.getConfig().get("prompt").isEmpty());
    }

    private static void unsupported(AuthenticationFlowContext context, IdentityProviderModel provider) {
        LOG.warnf("Broker account retry requires an enabled OIDC provider without a fixed prompt (provider %s)", provider.getAlias());
        context.failure(AuthenticationFlowError.ACCESS_DENIED);
    }

    static Response reauthenticate(AuthenticationSessionModel session, Supplier<Response> retry) {
        String original = session.getClientNote(OAuth2Constants.PROMPT);
        // Clear the rejected broker context before retrying, otherwise native
        // Keycloak treats another unlinked response as a nested linking flow.
        String locale = session.getAuthNote(LocaleSelectorProvider.USER_REQUEST_LOCALE);
        AuthenticationProcessor.resetFlow(session, LoginActionsService.AUTHENTICATE_PATH);
        if (locale != null) session.setAuthNote(LocaleSelectorProvider.USER_REQUEST_LOCALE, locale);
        session.setClientNote(OAuth2Constants.PROMPT, "select_account");
        try { return retry.get(); }
        finally {
            if (original == null) session.removeClientNote(OAuth2Constants.PROMPT);
            else session.setClientNote(OAuth2Constants.PROMPT, original);
        }
    }

    @Override public boolean requiresUser() { return false; }
    @Override public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) { return true; }
}
