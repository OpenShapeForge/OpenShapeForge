// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import java.util.List;
import org.keycloak.Config;
import org.keycloak.authentication.FormAction;
import org.keycloak.authentication.FormActionFactory;
import org.keycloak.models.AuthenticationExecutionModel.Requirement;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.provider.ProviderConfigProperty;

public final class InvitationEmailVerifiedFactory implements FormActionFactory {
    public static final String ID = "osf-invitation-email-verified";
    private static final InvitationEmailVerified SINGLETON = new InvitationEmailVerified();
    @Override public String getId() { return ID; }
    @Override public FormAction create(KeycloakSession session) { return SINGLETON; }
    @Override public String getDisplayType() { return "Invitation proves the email address"; }
    @Override public String getReferenceCategory() { return null; }
    @Override public boolean isConfigurable() { return false; }
    @Override public boolean isUserSetupAllowed() { return false; }
    @Override public Requirement[] getRequirementChoices() { return new Requirement[]{Requirement.REQUIRED, Requirement.DISABLED}; }
    @Override public String getHelpText() { return "Mark the email verified when the account is created from a matching organization invitation."; }
    @Override public List<ProviderConfigProperty> getConfigProperties() { return List.of(); }
    @Override public void init(Config.Scope config) { }
    @Override public void postInit(KeycloakSessionFactory factory) { }
    @Override public void close() { }
}
