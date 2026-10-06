// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import org.keycloak.authentication.RequiredActionContext;
import org.keycloak.authentication.requiredactions.WebAuthnPasswordlessRegister;
import org.keycloak.authentication.requiredactions.WebAuthnPasswordlessRegisterFactory;
import org.keycloak.authentication.requiredactions.WebAuthnRegister;
import org.keycloak.models.KeycloakSession;
import com.webauthn4j.verifier.attestation.trustworthiness.certpath.CertPathTrustworthinessVerifier;

/** Decorates the built-in provider; challenge, attestation and credential storage stay native. */
public final class EnrollmentRegisterFactory extends WebAuthnPasswordlessRegisterFactory {
    @Override public int order() { return 10; }

    @Override protected WebAuthnRegister createProvider(KeycloakSession session,
            CertPathTrustworthinessVerifier trustVerifier) {
        return new WebAuthnPasswordlessRegister(session, trustVerifier) {
            @Override public void processAction(RequiredActionContext context) {
                super.processAction(context);
                EnrollmentContinuation.resume(context);
                EnrollmentContinuation.replaceBrowserSession(context);
            }
        };
    }
}
