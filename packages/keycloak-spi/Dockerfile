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

FROM quay.io/keycloak/keycloak:26.7.2-0@sha256:6efbadc00f0ed0237610becf11f4101b9c3ad8edf08a5b70c97aa4154ed436ec
COPY --from=builder /build/target/openshapeforge-keycloak-spi.jar /opt/keycloak/providers/
RUN /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true
