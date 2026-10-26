// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import org.keycloak.Config;
import org.keycloak.authentication.RequiredActionFactory;
import org.keycloak.authentication.RequiredActionProvider;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;

public final class PasskeyOfferFactory implements RequiredActionFactory {
    private static final PasskeyOffer SINGLETON = new PasskeyOffer();
    @Override public String getId() { return PasskeyOffer.ID; }
    @Override public String getDisplayText() { return "Offer a passkey after email sign-in"; }
    @Override public RequiredActionProvider create(KeycloakSession session) { return SINGLETON; }
    @Override public void init(Config.Scope config) { }
    @Override public void postInit(KeycloakSessionFactory factory) { }
    @Override public void close() { }
}
