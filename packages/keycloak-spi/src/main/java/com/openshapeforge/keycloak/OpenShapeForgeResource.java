// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import jakarta.ws.rs.*;
import jakarta.ws.rs.core.Context;
import jakarta.ws.rs.core.HttpHeaders;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

import org.keycloak.models.ClientModel;
import org.keycloak.models.GroupModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.OrganizationModel;
import org.keycloak.models.RealmModel;
import org.keycloak.models.RoleModel;
import org.keycloak.models.UserModel;
import org.keycloak.organization.OrganizationProvider;
import org.keycloak.representations.AccessToken;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.managers.AuthenticationManager.AuthResult;

import java.util.*;
import java.util.stream.Collectors;

@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class OpenShapeForgeResource {

    private static final String ATTR_ORGANIZATION_LEVEL = "openshapeforge.organizationLevel";
    private static final String ATTR_PARENT_ORGANIZATION_ID = "openshapeforge.parentOrganizationId";
    private static final String ATTR_ROOT_ORGANIZATION_ID = "openshapeforge.rootOrganizationId";
    private static final String ATTR_ORGANIZATION_PATH = "openshapeforge.organizationPath";
    private static final String ATTR_ORGANIZATION_ID = "openshapeforge.organizationId";
    private static final String ATTR_SOURCE_AUTHORITY = "openshapeforge.sourceAuthority";
    private static final String ATTR_PERMISSION_GRANT = "openshapeforge.permissionGrant";
    private static final String ATTR_PERMISSION_TARGET = "openshapeforge.permissionTargetOrganizationId";
    private static final Set<String> ALLOWED_ADMIN_CLIENTS = Set.of("openshapeforge-auth-api");

    private final KeycloakSession session;
    private final RealmModel realm;
    private final OrganizationProvider organizations;

    @Context
    private HttpHeaders headers;

    public OpenShapeForgeResource(KeycloakSession session) {
        this.session = session;
        this.realm = session.getContext().getRealm();
        this.organizations = session.getProvider(OrganizationProvider.class);
    }

    @POST
    @Path("organizations")
    public Response createOrganization(OrganizationRequest request) {
        requireAdminBearer();
        if (request == null) {
            return badRequest("Request body is required.");
        }

        String alias = requireText(request.alias, "alias");
        String name = requireText(request.name, "name");
        String level = requireText(request.organizationLevel, "organizationLevel");
        String path = requireText(request.organizationPath, "organizationPath");

        if (!level.equals("root") && !level.equals("sub")) {
            return badRequest("organizationLevel must be root or sub.");
        }

        OrganizationModel parent = null;
        OrganizationModel root = null;
        if (level.equals("root")) {
            if (request.parentOrganizationId != null && !request.parentOrganizationId.isBlank()) {
                return badRequest("Root organizations cannot have parentOrganizationId.");
            }
        } else {
            parent = requireOrganization(request.parentOrganizationId, "parentOrganizationId");
            root = requireOrganization(request.rootOrganizationId, "rootOrganizationId");
            if (root == null || !rootAttribute(parent, ATTR_ROOT_ORGANIZATION_ID).equals(root.getId())) {
                return badRequest("Sub-organization parent and root organization do not match.");
            }
        }

        String requestedRootId = root == null ? null : root.getId();
        Optional<OrganizationModel> pathCollision = allOrganizations()
            .filter(org -> path.equals(first(org.getAttributes(), ATTR_ORGANIZATION_PATH)))
            .filter(org -> level.equals("root") || first(org.getAttributes(), ATTR_ROOT_ORGANIZATION_ID).equals(requestedRootId))
            .filter(org -> !org.getAlias().equals(alias))
            .findFirst();
        if (pathCollision.isPresent()) {
            return conflict("organizationPath is already used in this root organization.");
        }

        OrganizationModel organization = organizations.getByAlias(alias);
        if (organization == null) {
            // create(name, alias), NOT create(name, alias, null). The three-argument
            // overload is create(id, name, alias), so passing a trailing null bound
            // the display name to the ID parameter and the alias to the name — the
            // organization's ID became the name string instead of a generated uuid,
            // and that ID is what callers persist and address it by. The two-argument
            // form is a default method that delegates with a null id, which is what
            // makes the store generate one.
            organization = organizations.create(name, alias);
        }

        organization.setName(name);
        organization.setAlias(alias);
        organization.setEnabled(true);

        String rootId = level.equals("root") ? organization.getId() : root.getId();
        Map<String, List<String>> attrs = new LinkedHashMap<>(organization.getAttributes());
        attrs.put(ATTR_ORGANIZATION_LEVEL, List.of(level));
        attrs.put(ATTR_ROOT_ORGANIZATION_ID, List.of(rootId));
        attrs.put(ATTR_ORGANIZATION_PATH, List.of(path));
        attrs.put(ATTR_SOURCE_AUTHORITY, List.of("keycloak"));
        if (level.equals("sub")) {
            attrs.put(ATTR_PARENT_ORGANIZATION_ID, List.of(parent.getId()));
        } else {
            attrs.remove(ATTR_PARENT_ORGANIZATION_ID);
        }
        organization.setAttributes(attrs);

        return Response.ok(organizationResponse(organization)).build();
    }

    @POST
    @Path("organizations/{organizationId}/groups")
    public Response createOrganizationGroup(@PathParam("organizationId") String organizationId, ScopedGroupRequest request) {
        requireAdminBearer();
        OrganizationModel organization = requireOrganization(organizationId, "organizationId");
        if (organization == null) {
            return badRequest("organizationId is required.");
        }
        if (request == null) {
            return badRequest("Request body is required.");
        }

        String name = requireText(request.name, "name");
        GroupModel group = findScopedGroup(organization.getId(), request.externalId, name);
        if (group == null) {
            group = realm.createGroup(name);
        }
        group.setName(name);
        stampOrganizationScope(group, organization);
        if (request.externalId != null && !request.externalId.isBlank()) {
            group.setSingleAttribute("openshapeforge.externalId", request.externalId);
        }
        if (request.externalCode != null && !request.externalCode.isBlank()) {
            group.setSingleAttribute("openshapeforge.externalCode", request.externalCode);
        }

        return Response.ok(groupResponse(group)).build();
    }

    @PUT
    @Path("organizations/{organizationId}/groups/{groupId}")
    public Response updateOrganizationGroup(
        @PathParam("organizationId") String organizationId,
        @PathParam("groupId") String groupId,
        ScopedGroupRequest request
    ) {
        requireAdminBearer();
        OrganizationModel organization = requireOrganization(organizationId, "organizationId");
        GroupModel group = realm.getGroupById(groupId);
        if (organization == null || group == null) {
            return notFound("Organization or group was not found.");
        }
        if (!organization.getId().equals(group.getFirstAttribute(ATTR_ORGANIZATION_ID))) {
            return badRequest("Group is not scoped to the requested organization.");
        }
        if (request != null && request.name != null && !request.name.isBlank()) {
            group.setName(request.name);
        }
        stampOrganizationScope(group, organization);
        return Response.ok(groupResponse(group)).build();
    }

    @POST
    @Path("organizations/{organizationId}/groups/{groupId}/members")
    public Response reconcileOrganizationGroupMembers(
        @PathParam("organizationId") String organizationId,
        @PathParam("groupId") String groupId,
        MemberReconciliationRequest request
    ) {
        requireAdminBearer();
        OrganizationModel organization = requireOrganization(organizationId, "organizationId");
        GroupModel group = realm.getGroupById(groupId);
        if (organization == null || group == null) {
            return notFound("Organization or group was not found.");
        }
        if (!organization.getId().equals(group.getFirstAttribute(ATTR_ORGANIZATION_ID))) {
            return badRequest("Group is not scoped to the requested organization.");
        }
        if (request == null || request.userIds == null) {
            return badRequest("userIds is required.");
        }

        Set<String> targetUserIds = new LinkedHashSet<>(request.userIds);
        List<UserModel> targetUsers = new ArrayList<>();
        String organizationRootId = rootAttribute(organization, ATTR_ROOT_ORGANIZATION_ID);
        for (String userId : targetUserIds) {
            UserModel user = session.users().getUserById(realm, userId);
            if (user == null) {
                return badRequest("Unknown userId: " + userId);
            }
            String userRootId = userRootOrganizationId(user);
            if (!organizationRootId.equals(userRootId)) {
                return badRequest("Group member is outside the organization root scope: " + userId);
            }
            targetUsers.add(user);
        }

        List<UserModel> currentMembers = session.users().getGroupMembersStream(realm, group).collect(Collectors.toList());
        for (UserModel user : currentMembers) {
            if (!targetUserIds.contains(user.getId())) {
                user.leaveGroup(group);
            }
        }
        for (UserModel user : targetUsers) {
            user.joinGroup(group);
        }

        return Response.ok(Map.of("groupId", group.getId(), "memberCount", targetUserIds.size())).build();
    }

    @POST
    @Path("organizations/{organizationId}/roles")
    public Response createOrganizationRole(@PathParam("organizationId") String organizationId, ScopedRoleRequest request) {
        requireAdminBearer();
        OrganizationModel organization = requireOrganization(organizationId, "organizationId");
        if (organization == null) {
            return badRequest("organizationId is required.");
        }
        if (request == null) {
            return badRequest("Request body is required.");
        }

        String displayName = requireText(request.name, "name");
        String name = scopedRoleName(organization, displayName);
        RoleModel role = realm.getRole(name);
        if (role == null) {
            role = realm.addRole(name);
        }
        role.setSingleAttribute("openshapeforge.displayName", displayName);
        if (request.description != null) {
            role.setDescription(request.description);
        }
        stampOrganizationScope(role, organization);
        if (request.roleKind != null && !request.roleKind.isBlank()) {
            role.setSingleAttribute("openshapeforge.roleKind", request.roleKind);
        }

        return Response.ok(roleResponse(role)).build();
    }

    @PUT
    @Path("organizations/{organizationId}/permissions")
    public Response replaceOrganizationPermissions(
        @PathParam("organizationId") String organizationId,
        PermissionReplacementRequest request
    ) {
        requireAdminBearer();
        OrganizationModel organization = requireOrganization(organizationId, "organizationId");
        if (organization == null) {
            return badRequest("organizationId is required.");
        }
        if (request == null || request.permissions == null) {
            return badRequest("permissions is required.");
        }

        String roleName = "organization:" + organization.getAlias() + ":permissions";

        RoleModel role = realm.getRole(roleName);
        if (role == null) {
            role = realm.addRole(roleName);
        }
        role.setDescription("Permission composites for " + organization.getAlias());
        stampOrganizationScope(role, organization);

        List<RoleModel> existingComposites = role.getCompositesStream().collect(Collectors.toList());
        for (RoleModel composite : existingComposites) {
            role.removeCompositeRole(composite);
        }

        List<String> configuredPermissions = new ArrayList<>();
        for (PermissionRequest permission : request.permissions) {
            RoleModel clientPermission = requireClientPermission(permission);
            role.addCompositeRole(clientPermission);
            configuredPermissions.add(permission.clientId + ":" + permission.permissionName + ":" + normalizedEffect(permission.effect));
        }
        role.setAttribute("openshapeforge.permissions", configuredPermissions);

        return Response.ok(roleResponse(role)).build();
    }

    @PUT
    @Path("users/{userId}/organization-permissions")
    public Response replaceUserOrganizationPermissions(
        @PathParam("userId") String userId,
        UserPermissionReplacementRequest request
    ) {
        requireAdminBearer();
        UserModel user = session.users().getUserById(realm, userId);
        if (user == null) {
            return notFound("User was not found.");
        }
        if (request == null || request.grants == null) {
            return badRequest("grants is required.");
        }
        String userRootId = userRootOrganizationId(user);
        if (userRootId == null || userRootId.isBlank()) {
            return badRequest("User is missing root organization scope.");
        }
        if (request.rootOrganizationId != null && !request.rootOrganizationId.isBlank() && !request.rootOrganizationId.equals(userRootId)) {
            return badRequest("Requested root organization does not match the user root organization.");
        }

        List<ResolvedGrant> resolvedGrants = new ArrayList<>();
        for (UserPermissionGrantRequest grant : request.grants) {
            OrganizationModel target = requireOrganization(grant.targetOrganizationId, "targetOrganizationId");
            if (target == null) {
                return badRequest("targetOrganizationId is required.");
            }
            String expectedRootId = rootAttribute(target, ATTR_ROOT_ORGANIZATION_ID);
            if (!userRootId.equals(expectedRootId)) {
                return badRequest("Grant target is outside the user root organization.");
            }
            RoleModel clientPermission = requireClientPermission(grant);
            resolvedGrants.add(new ResolvedGrant(grant, target, clientPermission));
        }

        List<RoleModel> existingGrantRoles = user.getRealmRoleMappingsStream()
            .filter(role -> "true".equals(role.getFirstAttribute(ATTR_PERMISSION_GRANT)))
            .collect(Collectors.toList());
        for (RoleModel role : existingGrantRoles) {
            user.deleteRoleMapping(role);
        }

        for (ResolvedGrant resolvedGrant : resolvedGrants) {
            UserPermissionGrantRequest grant = resolvedGrant.grant;
            OrganizationModel target = resolvedGrant.target;
            RoleModel clientPermission = resolvedGrant.clientPermission;
            String grantRoleName = "organization:" + target.getAlias() + ":grant:" + grant.clientId + ":" + grant.permissionName;
            RoleModel grantRole = realm.getRole(grantRoleName);
            if (grantRole == null) {
                grantRole = realm.addRole(grantRoleName);
            }
            grantRole.setDescription("User permission grant for " + target.getAlias());
            grantRole.setSingleAttribute(ATTR_PERMISSION_GRANT, "true");
            grantRole.setSingleAttribute(ATTR_PERMISSION_TARGET, target.getId());
            stampOrganizationScope(grantRole, target);
            grantRole.getCompositesStream().collect(Collectors.toList()).forEach(grantRole::removeCompositeRole);
            grantRole.addCompositeRole(clientPermission);
            grantRole.setAttribute("openshapeforge.permissions", List.of(grant.clientId + ":" + grant.permissionName + ":" + normalizedEffect(grant.effect)));
            user.grantRole(grantRole);
        }

        return Response.ok(Map.of("userId", user.getId(), "grantCount", request.grants.size())).build();
    }

    private void requireAdminBearer() {
        AuthResult auth = new AppAuthManager.BearerTokenAuthenticator(session)
            .setRealm(realm)
            .setConnection(session.getContext().getConnection())
            .setHeaders(headers)
            .authenticate();
        if (auth == null) {
            throw new NotAuthorizedException("Bearer");
        }

        // Defense in depth: only tokens minted for the trusted auth-api service
        // account may reach the configuration SPI. This is an allowlist on the
        // azp claim, NOT an authorization decision on its own — the built-in
        // public "admin-cli" client is deliberately excluded because any realm
        // user can obtain a token whose azp is admin-cli via the direct-access
        // grant, which would otherwise bypass the check below.
        AccessToken token = auth.getToken();
        String issuedFor = token == null ? null : token.getIssuedFor();
        if (!ALLOWED_ADMIN_CLIENTS.contains(issuedFor)) {
            throw new ForbiddenException("Client is not allowed to use the OpenShapeForge identity configuration SPI.");
        }

        // Actual authorization: require the authenticated subject to hold the
        // realm-management "manage-realm" capability (Keycloak's realm-admin
        // right). This is evaluated directly against the stable Keycloak model
        // API (ClientModel/RoleModel/UserModel) rather than the internal admin
        // permissions evaluator (org.keycloak.services.resources.admin.*): that
        // class is a non-public server SPI whose package moved between Keycloak
        // 26.1 and 26.5, so binding to it makes the jar fail at runtime on a
        // different Keycloak minor than it was compiled against. UserModel.hasRole
        // traverses composites, so a realm-admin (which composes manage-realm) is
        // accepted too. A token whose subject lacks the capability is rejected
        // even when its azp is in ALLOWED_ADMIN_CLIENTS, so client identity alone
        // never grants access.
        UserModel subject = auth.getUser();
        if (subject == null) {
            throw new ForbiddenException("Token subject could not be resolved for authorization.");
        }
        ClientModel realmManagement = realm.getClientByClientId("realm-management");
        RoleModel manageRealm = realmManagement == null ? null : realmManagement.getRole("manage-realm");
        if (manageRealm == null || !subject.hasRole(manageRealm)) {
            throw new ForbiddenException("Subject lacks the realm-management manage-realm capability required by the OpenShapeForge identity configuration SPI.");
        }
    }

    private RoleModel requireClientPermission(PermissionRequest permission) {
        String clientId = requireText(permission.clientId, "clientId");
        String permissionName = requireText(permission.permissionName, "permissionName");
        ClientModel client = session.clients().getClientByClientId(realm, clientId);
        if (client == null) {
            throw new BadRequestException("Unknown clientId: " + clientId);
        }
        RoleModel role = client.getRole(permissionName);
        if (role == null) {
            throw new BadRequestException("Unknown permissionName for " + clientId + ": " + permissionName);
        }
        return role;
    }

    private OrganizationModel requireOrganization(String organizationId, String field) {
        if (organizationId == null || organizationId.isBlank()) {
            return null;
        }
        OrganizationModel organization = organizations.getById(organizationId);
        if (organization == null) {
            throw new BadRequestException(field + " does not reference an existing organization.");
        }
        return organization;
    }

    private java.util.stream.Stream<OrganizationModel> allOrganizations() {
        return organizations.getAllStream(null, null, null, null);
    }

    private GroupModel findScopedGroup(String organizationId, String externalId, String name) {
        return realm.getGroupsStream()
            .filter(group -> organizationId.equals(group.getFirstAttribute(ATTR_ORGANIZATION_ID)))
            .filter(group -> {
                if (externalId != null && !externalId.isBlank()) {
                    return externalId.equals(group.getFirstAttribute("openshapeforge.externalId"));
                }
                return name.equals(group.getName());
            })
            .findFirst()
            .orElse(null);
    }

    private void stampOrganizationScope(GroupModel group, OrganizationModel organization) {
        group.setSingleAttribute(ATTR_ORGANIZATION_ID, organization.getId());
        group.setSingleAttribute(ATTR_ROOT_ORGANIZATION_ID, rootAttribute(organization, ATTR_ROOT_ORGANIZATION_ID));
        group.setSingleAttribute(ATTR_ORGANIZATION_PATH, first(organization.getAttributes(), ATTR_ORGANIZATION_PATH));
        group.setSingleAttribute(ATTR_SOURCE_AUTHORITY, "keycloak");
    }

    private void stampOrganizationScope(RoleModel role, OrganizationModel organization) {
        role.setSingleAttribute(ATTR_ORGANIZATION_ID, organization.getId());
        role.setSingleAttribute(ATTR_ROOT_ORGANIZATION_ID, rootAttribute(organization, ATTR_ROOT_ORGANIZATION_ID));
        role.setSingleAttribute(ATTR_ORGANIZATION_PATH, first(organization.getAttributes(), ATTR_ORGANIZATION_PATH));
        role.setSingleAttribute(ATTR_SOURCE_AUTHORITY, "keycloak");
    }

    private String rootAttribute(OrganizationModel organization, String attribute) {
        String value = first(organization.getAttributes(), attribute);
        return value == null || value.isBlank() ? organization.getId() : value;
    }

    private String userRootOrganizationId(UserModel user) {
        String userRootId = user.getFirstAttribute(ATTR_ROOT_ORGANIZATION_ID);
        if (userRootId != null && !userRootId.isBlank()) {
            return userRootId;
        }
        return organizations.getByMember(user)
            .map(organization -> rootAttribute(organization, ATTR_ROOT_ORGANIZATION_ID))
            .filter(Objects::nonNull)
            .findFirst()
            .orElse(null);
    }

    private String first(Map<String, List<String>> attributes, String key) {
        List<String> values = attributes.get(key);
        return values == null || values.isEmpty() ? null : values.get(0);
    }

    private Map<String, Object> organizationResponse(OrganizationModel organization) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("id", organization.getId());
        response.put("organizationId", organization.getId());
        response.put("alias", organization.getAlias());
        response.put("name", organization.getName());
        response.put("organizationLevel", first(organization.getAttributes(), ATTR_ORGANIZATION_LEVEL));
        response.put("rootOrganizationId", rootAttribute(organization, ATTR_ROOT_ORGANIZATION_ID));
        response.put("parentOrganizationId", first(organization.getAttributes(), ATTR_PARENT_ORGANIZATION_ID));
        response.put("organizationPath", first(organization.getAttributes(), ATTR_ORGANIZATION_PATH));
        return response;
    }

    private Map<String, Object> groupResponse(GroupModel group) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("id", group.getId());
        response.put("groupId", group.getId());
        response.put("name", group.getName());
        response.put("organizationId", group.getFirstAttribute(ATTR_ORGANIZATION_ID));
        response.put("rootOrganizationId", group.getFirstAttribute(ATTR_ROOT_ORGANIZATION_ID));
        response.put("organizationPath", group.getFirstAttribute(ATTR_ORGANIZATION_PATH));
        return response;
    }

    private Map<String, Object> roleResponse(RoleModel role) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("id", role.getId());
        response.put("roleId", role.getId());
        response.put("name", role.getName());
        response.put("description", role.getDescription());
        response.put("organizationId", role.getFirstAttribute(ATTR_ORGANIZATION_ID));
        response.put("rootOrganizationId", role.getFirstAttribute(ATTR_ROOT_ORGANIZATION_ID));
        response.put("organizationPath", role.getFirstAttribute(ATTR_ORGANIZATION_PATH));
        response.put("composites", role.getCompositesStream().map(RoleModel::getName).sorted().collect(Collectors.toList()));
        return response;
    }

    private String requireText(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new BadRequestException(field + " is required.");
        }
        return value;
    }

    private String normalizedEffect(String effect) {
        if (effect == null || effect.isBlank()) {
            return "allow";
        }
        if (!effect.equals("allow")) {
            throw new BadRequestException("Only allow effects are supported.");
        }
        return effect;
    }

    private String scopedRoleName(OrganizationModel organization, String displayName) {
        return "organization:" + organization.getAlias() + ":role:" + displayName;
    }

    private Response badRequest(String message) {
        return Response.status(Response.Status.BAD_REQUEST).entity(Map.of("error", message)).build();
    }

    private Response conflict(String message) {
        return Response.status(Response.Status.CONFLICT).entity(Map.of("error", message)).build();
    }

    private Response notFound(String message) {
        return Response.status(Response.Status.NOT_FOUND).entity(Map.of("error", message)).build();
    }

    public static class OrganizationRequest {
        public String alias;
        public String name;
        public String organizationLevel;
        public String parentOrganizationId;
        public String rootOrganizationId;
        public String organizationPath;
    }

    public static class ScopedGroupRequest {
        public String name;
        public String externalId;
        public String externalCode;
    }

    public static class MemberReconciliationRequest {
        public List<String> userIds;
    }

    public static class ScopedRoleRequest {
        public String name;
        public String description;
        public String roleKind;
    }

    public static class PermissionReplacementRequest {
        public List<PermissionRequest> permissions;
    }

    public static class PermissionRequest {
        public String clientId;
        public String permissionName;
        public String effect;
    }

    public static class UserPermissionReplacementRequest {
        public String rootOrganizationId;
        public List<UserPermissionGrantRequest> grants;
    }

    public static class UserPermissionGrantRequest extends PermissionRequest {
        public String targetOrganizationId;
    }

    private record ResolvedGrant(
        UserPermissionGrantRequest grant,
        OrganizationModel target,
        RoleModel clientPermission
    ) {}
}
