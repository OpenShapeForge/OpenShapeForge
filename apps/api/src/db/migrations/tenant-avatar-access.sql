-- This predicate grants no write. It narrows the additional Document read role
-- to one tenant-owned logo and prevents broad dossier access through that role.
-- The active Tenant pointer owns this document; a company Relation is optional
-- metadata and cannot grant or revoke access to that tenant's logo.
-- Apply the additional read fence to the API role. Its SECURITY DEFINER
-- predicate must still read through ordinary tenant RLS as the non-superuser
-- migration owner, without invoking its own restrictive policy recursively.
CREATE OR REPLACE FUNCTION document_internal.is_tenant_avatar(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM erp.documents d JOIN platform.tenants t ON t.id = d.tenant_id
    JOIN erp.tenants registry ON registry.id = t.id
    WHERE d.id = target AND d.tenant_id = app.current_tenant()
      AND d.document_type = 'avatar'
      AND d.code = 'tenant-logo'
      AND d.case_file_id IS NULL AND d.case_id IS NULL
      AND (to_jsonb(registry)->>'logo_document_id')::uuid = d.id
  )
$$;
REVOKE ALL ON FUNCTION document_internal.is_tenant_avatar(uuid) FROM public;
GRANT EXECUTE ON FUNCTION document_internal.is_tenant_avatar(uuid) TO openshapeforge_app;

DROP POLICY IF EXISTS documents_tenant_avatar_read ON erp.documents;
CREATE POLICY documents_tenant_avatar_read ON erp.documents AS RESTRICTIVE FOR SELECT TO openshapeforge_app USING (
  NOT ('Organization.Access.Manage' = ANY(string_to_array(coalesce(current_setting('app.roles',true),''),',')))
  OR string_to_array(coalesce(current_setting('app.roles',true),''),',') && ARRAY['CaseFile.All.Read','CaseFile.All.ReadWrite']
  OR document_internal.is_tenant_avatar(id)
);
DROP POLICY IF EXISTS document_versions_tenant_avatar_read ON erp.document_versions;
CREATE POLICY document_versions_tenant_avatar_read ON erp.document_versions AS RESTRICTIVE FOR SELECT TO openshapeforge_app USING (
  NOT ('Organization.Access.Manage' = ANY(string_to_array(coalesce(current_setting('app.roles',true),''),',')))
  OR string_to_array(coalesce(current_setting('app.roles',true),''),',') && ARRAY['CaseFile.All.Read','CaseFile.All.ReadWrite']
  OR document_internal.is_tenant_avatar(document_id)
);
-- Derived files are append-only source/version facts, just like source versions.
CREATE OR REPLACE FUNCTION document_internal.protect_rendition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'DocumentRendition is immutable; create a new source version instead';
END
$$;
REVOKE ALL ON FUNCTION document_internal.protect_rendition() FROM public;
DO $guard$
BEGIN
  IF to_regclass('erp.document_renditions') IS NOT NULL THEN
DROP POLICY IF EXISTS document_renditions_tenant_avatar_read ON erp.document_renditions;
CREATE POLICY document_renditions_tenant_avatar_read ON erp.document_renditions AS RESTRICTIVE FOR SELECT TO openshapeforge_app USING (
  NOT ('Organization.Access.Manage' = ANY(string_to_array(coalesce(current_setting('app.roles',true),''),',')))
  OR string_to_array(coalesce(current_setting('app.roles',true),''),',') && ARRAY['CaseFile.All.Read','CaseFile.All.ReadWrite']
  OR EXISTS (SELECT 1 FROM erp.document_versions v WHERE v.id = source_document_version_id AND v.tenant_id = app.current_tenant() AND document_internal.is_tenant_avatar(v.document_id))
);
DROP TRIGGER IF EXISTS document_renditions_immutable ON erp.document_renditions;
CREATE TRIGGER document_renditions_immutable BEFORE UPDATE OR DELETE ON erp.document_renditions
FOR EACH ROW EXECUTE FUNCTION document_internal.protect_rendition();
  END IF;
END
$guard$;
