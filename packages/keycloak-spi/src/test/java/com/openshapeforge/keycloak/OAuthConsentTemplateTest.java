// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import freemarker.cache.StringTemplateLoader;
import freemarker.cache.ClassTemplateLoader;
import freemarker.cache.MultiTemplateLoader;
import freemarker.cache.TemplateLoader;
import java.util.Properties;
import freemarker.template.Configuration;
import freemarker.template.TemplateMethodModelEx;
import java.io.StringWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public class OAuthConsentTemplateTest {
    public static final class ConsentUrl {
        public String getOauthAction() { return "/native/consent"; }
        public String getLoginAction() { throw new IllegalStateException("action URI not set"); }
    }

    @Test public void importedLayoutDoesNotReadMissingLoginActionAndKeepsExplicitConsent() throws Exception {
        var source = Files.readString(Path.of("theme/openshapeforge/login/login-oauth-grant.ftl"));
        var loader = new StringTemplateLoader();
        // Reproduce the inherited layout's imported namespace and its failing
        // organization-switch access, with an actual throwing bean property.
        loader.putTemplate("template.ftl", "<#macro registrationLayout bodyClass=''><#nested 'header'><#nested 'form'><#if switchOrganizationEnabled><form action='${url.loginAction}'></form></#if></#macro>");
        loader.putTemplate("consent.ftl", source);
        var config = new Configuration(Configuration.VERSION_2_3_32);
        config.setTemplateLoader(new MultiTemplateLoader(new TemplateLoader[]{loader, new ClassTemplateLoader(getClass(), "/theme/keycloak.v2/login")}));
        var properties = new Properties();
        try (var sourceProperties = getClass().getResourceAsStream("/theme/keycloak.v2/login/theme.properties")) { properties.load(sourceProperties); }
        TemplateMethodModelEx text = args -> args.get(0).toString();
        var data = Map.of("switchOrganizationEnabled", true,
            "client", Map.of("name", "Synthetic client", "attributes", Map.of()),
            "oauth", Map.of("code", "native-code", "clientScopesRequested", List.of(Map.of("consentScreenText", "Requested organization"))),
            "url", new ConsentUrl(), "properties", properties, "msg", text, "advancedMsg", text);
        var out = new StringWriter();
        config.getTemplate("consent.ftl").process(data, out);
        String html = out.toString();
        assertTrue(html.contains("action=\"/native/consent\" method=\"POST\""));
        assertTrue(html.contains("name=\"code\" value=\"native-code\""));
        assertTrue(html.contains("Requested organization"));
        assertTrue(html.contains("name=\"accept\""));
        assertTrue(html.contains("name=\"cancel\""));
        assertTrue(html.contains(properties.getProperty("kcButtonSecondaryClass")));
        assertTrue(html.contains(properties.getProperty("kcListClass")));
        assertEquals(Boolean.TRUE, data.get("switchOrganizationEnabled"));
    }
    public static final class LoginUrl {
        public String getLoginAction() { return "/native/first-broker-login"; }
    }
    @Test public void retryEscapesTheRejectedAccountAndKeepsNativeFormActions() throws Exception {
        var loader = new StringTemplateLoader();
        loader.putTemplate("template.ftl", "<#macro registrationLayout displayMessage=true><#nested 'header'><#nested 'form'></#macro>");
        loader.putTemplate("retry.ftl", Files.readString(Path.of("theme/openshapeforge/login/broker-account-retry.ftl")));
        var config = new Configuration(Configuration.VERSION_2_3_32); config.setTemplateLoader(loader);
        TemplateMethodModelEx text = args -> args.size() > 1 ? args.get(1).toString() : args.get(0).toString();
        var out = new StringWriter();
        config.getTemplate("retry.ftl").process(Map.of("brokerAccount", "<script>injected</script>", "url", new LoginUrl(), "properties", Map.of(), "msg", text), out);
        String html = out.toString();
        assertFalse(html.contains("<script>")); assertTrue(html.contains("&lt;script&gt;"));
        assertTrue(html.contains("action=\"/native/first-broker-login\""));
        assertTrue(html.contains("name=\"retry\" value=\"true\""));
        assertTrue(html.contains("name=\"cancel\""));
    }
}
