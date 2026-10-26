<#-- SPDX-License-Identifier: BUSL-1.1 -->
<#import "template.ftl" as layout>
<@layout.emailLayout>
${kcSanitize(msg("osfEmailSignInBodyHtml", link, code, ttlMinutes, realmName))?no_esc}
</@layout.emailLayout>
