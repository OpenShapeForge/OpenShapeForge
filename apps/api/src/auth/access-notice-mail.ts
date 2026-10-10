// SPDX-License-Identifier: BUSL-1.1
/**
 * The e-mail an existing organization member gets when an administrator
 * admits them with a role. Keycloak sends no invitation to an address that is
 * already a member, so without this the person learns of their new access only
 * by chance. Dutch first, English below: the person's locale is not known here.
 */
export type AccessNoticeInput = {
  email: string;
  firstName?: string | null | undefined;
  tenantName: string;
  role?: { en?: string | undefined; nl?: string | undefined } | null | undefined;
  signInUrl: string | null;
};

export function accessNoticeMail(input: AccessNoticeInput): { to: string; subject: string; text: string } {
  const name = input.firstName?.trim();
  const role = (language: "nl" | "en") => {
    const label = input.role?.[language] ?? input.role?.en;
    return label ? (language === "nl" ? ` met de rol ${label}` : ` with the role ${label}`) : "";
  };
  const nl = input.signInUrl
    ? `Log in met je bestaande account via ${input.signInUrl}; de rol wordt dan toegepast.`
    : `Log in met je bestaande account bij ${input.tenantName}; de rol wordt dan toegepast.`;
  const en = input.signInUrl
    ? `Sign in with your existing account at ${input.signInUrl}; the role is applied when you do.`
    : `Sign in with your existing account at ${input.tenantName}; the role is applied when you do.`;
  return {
    to: input.email,
    subject: `Je hebt toegang tot ${input.tenantName} / You have access to ${input.tenantName}`,
    text: [
      `Hallo${name ? ` ${name}` : ""},`, "",
      `Je hebt toegang gekregen tot ${input.tenantName}${role("nl")}. ${nl}`, "",
      "—", "",
      `Hello${name ? ` ${name}` : ""},`, "",
      `You have been given access to ${input.tenantName}${role("en")}. ${en}`, "",
    ].join("\n"),
  };
}
