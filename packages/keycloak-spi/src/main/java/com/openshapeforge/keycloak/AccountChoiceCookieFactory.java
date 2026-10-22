// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.authenticators.browser.CookieAuthenticatorFactory;
import org.keycloak.models.KeycloakSession;

/** Preserve the native factory contract and flow bindings; add select_account. */
public final class AccountChoiceCookieFactory extends CookieAuthenticatorFactory {
    @Override public int order() { return 10; }
    @Override public Authenticator create(KeycloakSession session) { return new AccountChoiceCookie(); }
}
