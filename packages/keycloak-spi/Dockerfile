# Single source of truth for the Keycloak version. It flows into both the Maven
# compile (-Dkeycloak.version) and the runtime base image, so the SPI is always
# built against the exact server it runs on. The SPI depends on internal server
# SPIs with no cross-minor stability guarantee, so the compile-time and runtime
# versions must never drift apart.
ARG KEYCLOAK_VERSION=26.5.3

FROM maven:3.9-eclipse-temurin-17 AS builder
ARG KEYCLOAK_VERSION
WORKDIR /build
COPY pom.xml .
RUN mvn dependency:go-offline -B -Dkeycloak.version=${KEYCLOAK_VERSION}
COPY src ./src
RUN mvn package -B -DskipTests -Dkeycloak.version=${KEYCLOAK_VERSION}

FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}
COPY --from=builder /build/target/openshapeforge-keycloak-spi.jar /opt/keycloak/providers/
RUN /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true
