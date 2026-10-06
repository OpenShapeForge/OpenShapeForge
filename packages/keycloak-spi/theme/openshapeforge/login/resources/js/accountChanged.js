// A bounded server-authored return after native required-action completion.
window.addEventListener("DOMContentLoaded", () => {
  const link = document.querySelector("#kc-info-message a[href]");
  if (!link) return;
  const target = new URL(link.href);
  if (target.searchParams.get("account_changed") !== "1") return;
  if (target.protocol !== "https:" && !(target.protocol === "http:" && ["localhost", "127.0.0.1"].includes(target.hostname))) return;
  window.location.replace(target.href);
});
