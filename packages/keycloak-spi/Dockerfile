# Base images are pinned by DIGEST as well as tag. `maven:3.9-eclipse-temurin-17`
# in particular floats across Maven patch and base-OS releases, so the tag alone
# does not describe the bytes a rebuild pulls. Dependabot's docker ecosystem
# (.github/dependabot.yml) bumps the tag and the digest together.
FROM maven:3.9-eclipse-temurin-17@sha256:1ed5d1f54416b706707b4f3238f63a20bb06aab27c6d240090a2bb9ad895ed45 AS builder
WORKDIR /build
COPY pom.xml .
RUN mvn dependency:go-offline -B
COPY src ./src
RUN mvn package -B -DskipTests

FROM quay.io/keycloak/keycloak:26.7.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13
COPY --from=builder /build/target/openshapeforge-keycloak-spi.jar /opt/keycloak/providers/
RUN /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true
