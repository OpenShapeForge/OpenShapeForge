// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak.local;

import java.net.URI;
import java.net.InetAddress;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import org.keycloak.Config;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.AuthenticatorFactory;
import org.keycloak.authentication.AuthenticationProcessor;
import org.keycloak.models.AuthenticationExecutionModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.models.UserSessionModel;
import org.keycloak.services.managers.AuthenticationManager;
import org.keycloak.services.util.AuthenticationFlowURLHelper;
import org.keycloak.provider.ProviderConfigProperty;
import org.keycloak.util.JsonSerialization;
import jakarta.ws.rs.core.Response;

/** Opt-in, separately built local provider. Never changes credentials or memberships. */
public final class LocalAccountAuthenticator implements Authenticator, AuthenticatorFactory {
    public static final String ID = "osf-local-account-login";
    private static final String REPLACEMENT_USER = "osf.local-replacement-user";

    static boolean localUri(String value) {
        try {
            URI uri = URI.create(value);
            String host = uri.getHost() == null ? null : uri.getHost().toLowerCase(Locale.ROOT);
            return uri.getRawUserInfo() == null && Set.of("http", "https").contains(uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT)) && host != null
                && (Set.of("localhost", "127.0.0.1", "[::1]", "::1").contains(host)
                    || host.endsWith(".localhost"));
        } catch (RuntimeException e) { return false; }
    }

    private boolean allowed(AuthenticationFlowContext context) {
        if (!localPeer(context.getSession().getContext().getConnection().getRemoteAddr(),
            System.getenv("OSF_LOCAL_LOGIN_TRUSTED_PEERS"))) return false;
        return allowed(System.getenv("OSF_LOCAL_LOGIN_ENABLED"), System.getenv("OSF_LOCAL_LOGIN_REALMS"),
            context.getRealm().getName(), context.getUriInfo().getBaseUri().toString(),
            context.getUriInfo().getRequestUri().toString(), context.getAuthenticationSession().getRedirectUri());
    }

    static boolean allowed(String enabled, String realms, String realm, String base, String request, String redirect) {
        return "true".equals(enabled) && realms != null && Arrays.stream(realms.split(",")).map(String::trim).anyMatch(realm::equals)
            && localUri(base) && localUri(request) && localUri(redirect);
    }

    static boolean localPeer(String peer, String trustedPeers) {
        if (peer == null) return false;
        if (peer.contains(":")) {
            if (!peer.matches("[0-9a-fA-F:.]+")) return false;
        } else {
            if (!peer.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) return false;
            if (Arrays.stream(peer.split("\\.")).anyMatch(part -> Integer.parseInt(part) > 255)) return false;
        }
        try {
            var address = InetAddress.getByName(peer);
            if (address.isLoopbackAddress()) return true;
            byte[] bytes = address.getAddress();
            boolean uniqueLocalV6 = bytes.length == 16 && (bytes[0] & 0xfe) == 0xfc;
            if (trustedPeers == null || !(address.isSiteLocalAddress() || address.isLinkLocalAddress() || uniqueLocalV6)) return false;
            // Exact literal peers only; no DNS, subnet or wildcard trust.
            return Arrays.stream(trustedPeers.split(",")).map(String::trim).anyMatch(peer::equals);
        } catch (java.net.UnknownHostException e) { return false; }
    }

    static boolean listed(String serviceAccountClientLink, String username) {
        return serviceAccountClientLink == null && username != null;
    }

    static boolean eligible(boolean enabled, String serviceAccountClientLink, String username) {
        return enabled && listed(serviceAccountClientLink, username);
    }

    @Override public void authenticate(AuthenticationFlowContext context) {
        if (!allowed(context)) { context.attempted(); return; }
        String replacement = context.getAuthenticationSession().getAuthNote(REPLACEMENT_USER);
        if (replacement != null) {
            context.getAuthenticationSession().removeAuthNote(REPLACEMENT_USER);
            var user = context.getSession().users().getUserById(context.getRealm(), replacement);
            if (user == null || !eligible(user.isEnabled(), user.getServiceAccountClientLink(), user.getUsername())
                    || browserSessionToReplace(context, user) != null) {
                challenge(context, "osfLocalAccountUnavailable"); return;
            }
            context.setUser(user);
            context.getEvent().detail("auth_method", ID);
            context.success();
            return;
        }
        challenge(context, null);
    }

    private void challenge(AuthenticationFlowContext context, String error) {
        try (var stream = context.getSession().users().searchForUserStream(context.getRealm(), Map.of(), null, null)) {
            var accounts = stream.filter(user -> listed(user.getServiceAccountClientLink(), user.getUsername()))
                .sorted(Comparator.comparing(UserModel::getUsername))
                .map(user -> Map.of("value", user.getId(), "label", user.getUsername(),
                    "description", String.join(" ",
                        user.getFirstName() == null ? "" : user.getFirstName(),
                        user.getLastName() == null ? "" : user.getLastName()).trim(),
                    "disabled", !user.isEnabled()))
                .toList();
            var form = context.form().setAttribute("localAccounts", JsonSerialization.writeValueAsString(accounts))
                .setAttribute("localLanguage", context.getSession().getContext().resolveLocale(context.getUser()).toLanguageTag())
                ;
            if (error != null) form.setError(error);
            var response = form.createForm("local-accounts.ftl");
            if (error != null) context.failureChallenge(AuthenticationFlowError.ACCESS_DENIED, response);
            else context.challenge(response);
        } catch (java.io.IOException e) {
            context.failure(AuthenticationFlowError.INTERNAL_ERROR);
        }
    }

    @Override public void action(AuthenticationFlowContext context) {
        if (!allowed(context)) { context.failure(AuthenticationFlowError.ACCESS_DENIED); return; }
        var data = context.getHttpRequest().getDecodedFormParameters();
        if ("normal".equals(data.getFirst("mode"))) { context.attempted(); return; }
        String id = data.getFirst("account");
        UserModel user = id == null ? null : context.getSession().users().getUserById(context.getRealm(), id);
        if (user == null || !eligible(user.isEnabled(), user.getServiceAccountClientLink(), user.getUsername())) {
            challenge(context, "osfLocalAccountUnavailable"); return;
        }
        var old = browserSessionToReplace(context, user);
        if (old != null) {
            // Only the SSO session owning this browser authentication is replaced.
            // End its client sessions before Keycloak attaches the selected user;
            // otherwise attachSession rejects the two different identities.
            AuthenticationManager.backchannelLogout(context.getSession(), old, true);
            AuthenticationManager.expireIdentityCookie(context.getSession());
            // Rotate the root authentication session too. Persistent Keycloak
            // sessions cannot change user under the previous browser-session id.
            // Native recreation preserves the client's PKCE, nonce and state.
            var next = AuthenticationProcessor.recreate(context.getSession(), context.getAuthenticationSession());
            AuthenticationProcessor.resetFlow(next, context.getFlowPath());
            next.setAuthNote(REPLACEMENT_USER, user.getId());
            var target = new AuthenticationFlowURLHelper(context.getSession(), context.getRealm(), context.getUriInfo())
                .getLastExecutionUrl(next);
            context.forceChallenge(Response.seeOther(target).build());
            return;
        }
        context.setUser(user);
        context.getEvent().detail("auth_method", ID);
        context.success();
    }

    static UserSessionModel browserSessionToReplace(AuthenticationFlowContext context, UserModel selected) {
        if (selected == null || !eligible(selected.isEnabled(), selected.getServiceAccountClientLink(), selected.getUsername())) return null;
        var auth = context.getAuthenticationSession();
        var old = context.getSession().sessions().getUserSession(context.getRealm(), auth.getParentSession().getId());
        return old != null && old.getUser() != null && !old.getUser().getId().equals(selected.getId()) ? old : null;
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
