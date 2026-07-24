// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import org.keycloak.models.KeycloakSession;
import org.keycloak.services.resource.RealmResourceProvider;

public class OpenShapeForgeResourceProvider implements RealmResourceProvider {

    private final KeycloakSession session;

    public OpenShapeForgeResourceProvider(KeycloakSession session) {
        this.session = session;
    }

    @Override
    public Object getResource() {
        return new OpenShapeForgeResource(session);
    }

    @Override
    public void close() {
    }
}
