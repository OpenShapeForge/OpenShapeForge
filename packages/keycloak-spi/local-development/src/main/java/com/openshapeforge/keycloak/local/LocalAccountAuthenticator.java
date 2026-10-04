// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak.local;

import java.net.URI;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.keycloak.Config;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.AuthenticatorFactory;
import org.keycloak.models.AuthenticationExecutionModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.provider.ProviderConfigProperty;
import org.keycloak.util.JsonSerialization;

/** Opt-in, separately built local provider. Never changes credentials or memberships. */
public final class LocalAccountAuthenticator implements Authenticator, AuthenticatorFactory {
    public static final String ID = "osf-local-account-login";

    static boolean localUri(String value) {
        try {
            URI uri = URI.create(value);
            String host = uri.getHost();
            return uri.getRawUserInfo() == null && Set.of("http", "https").contains(uri.getScheme()) && host != null
                && (Set.of("localhost", "127.0.0.1", "[::1]", "::1").contains(host)
                    || host.endsWith(".localhost"));
        } catch (RuntimeException e) { return false; }
    }

    private boolean allowed(AuthenticationFlowContext context) {
        return allowed(System.getenv("OSF_LOCAL_LOGIN_ENABLED"), System.getenv("OSF_LOCAL_LOGIN_REALMS"),
            context.getRealm().getName(), context.getUriInfo().getBaseUri().toString(),
            context.getUriInfo().getRequestUri().toString(), context.getAuthenticationSession().getRedirectUri());
    }

    static boolean allowed(String enabled, String realms, String realm, String base, String request, String redirect) {
        return "true".equals(enabled) && realms != null && List.of(realms.split(",")).contains(realm)
            && localUri(base) && localUri(request) && localUri(redirect);
    }

    @Override public void authenticate(AuthenticationFlowContext context) {
        if (!allowed(context)) { context.attempted(); return; }
        challenge(context, null);
    }

    private void challenge(AuthenticationFlowContext context, String error) {
        try (var stream = context.getSession().users().searchForUserStream(context.getRealm(), Map.of(), null, null)) {
            var accounts = stream.filter(user -> user.getServiceAccountClientLink() == null)
                .sorted(Comparator.comparing(UserModel::getUsername))
                .map(user -> Map.of("value", user.getId(), "label", user.getUsername(),
                    "description", String.join(" ",
                        user.getFirstName() == null ? "" : user.getFirstName(),
                        user.getLastName() == null ? "" : user.getLastName()).trim(),
                    "disabled", !user.isEnabled()))
                .toList();
            boolean dutch = dutch(context);
            var form = context.form().setAttribute("localAccounts", JsonSerialization.writeValueAsString(accounts))
                .setAttribute("localLanguage", dutch ? "nl" : "en")
                .setAttribute("localTitle", dutch ? "Lokaal developmentaccount" : "Local development account");
            if (error != null) form.setError(error);
            context.challenge(form.createForm("local-accounts.ftl"));
        } catch (java.io.IOException e) {
            context.failure(AuthenticationFlowError.INTERNAL_ERROR);
        }
    }

    private boolean dutch(AuthenticationFlowContext context) {
        var languages = context.getHttpRequest().getHttpHeaders().getAcceptableLanguages();
        return !languages.isEmpty() && "nl".equals(languages.get(0).getLanguage());
    }

    @Override public void action(AuthenticationFlowContext context) {
        if (!allowed(context)) { context.failure(AuthenticationFlowError.ACCESS_DENIED); return; }
        var data = context.getHttpRequest().getDecodedFormParameters();
        if ("normal".equals(data.getFirst("mode"))) { context.attempted(); return; }
        String id = data.getFirst("account");
        UserModel user = id == null ? null : context.getSession().users().getUserById(context.getRealm(), id);
        if (user == null || !user.isEnabled() || user.getServiceAccountClientLink() != null) {
            challenge(context, dutch(context) ? "Dit account is niet beschikbaar voor aanmelden."
                : "This account is not available for sign-in."); return;
        }
        context.setUser(user);
        context.getEvent().detail("auth_method", ID);
        context.success();
    }

    @Override public boolean requiresUser() { return false; }
    @Override public boolean configuredFor(KeycloakSession s, RealmModel r, UserModel u) { return true; }
    @Override public void setRequiredActions(KeycloakSession s, RealmModel r, UserModel u) { }
    @Override public Authenticator create(KeycloakSession session) { return this; }
    @Override public String getId() { return ID; }
    @Override public String getDisplayType() { return "Local development accounts"; }
    @Override public String getReferenceCategory() { return "local-development"; }
    @Override public String getHelpText() { return "Local-only realm account chooser; separate provider and server opt-in required."; }
    @Override public boolean isConfigurable() { return false; }
    @Override public boolean isUserSetupAllowed() { return false; }
    @Override public AuthenticationExecutionModel.Requirement[] getRequirementChoices() {
        return new AuthenticationExecutionModel.Requirement[] {
            AuthenticationExecutionModel.Requirement.ALTERNATIVE, AuthenticationExecutionModel.Requirement.DISABLED };
    }
    @Override public List<ProviderConfigProperty> getConfigProperties() { return List.of(); }
    @Override public void init(Config.Scope c) { }
    @Override public void postInit(KeycloakSessionFactory f) { }
    @Override public void close() { }
}
