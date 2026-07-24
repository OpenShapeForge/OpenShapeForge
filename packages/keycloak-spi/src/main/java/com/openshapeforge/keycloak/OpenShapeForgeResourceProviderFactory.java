// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import org.keycloak.Config;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.services.resource.RealmResourceProviderFactory;

public class OpenShapeForgeResourceProviderFactory implements RealmResourceProviderFactory {

    public static final String ID = "openshapeforge";

    @Override
    public String getId() {
        return ID;
    }

    @Override
    public OpenShapeForgeResourceProvider create(KeycloakSession session) {
        return new OpenShapeForgeResourceProvider(session);
    }

    @Override
    public void init(Config.Scope config) {
    }

    @Override
    public void postInit(KeycloakSessionFactory factory) {
    }

    @Override
    public void close() {
    }
}
