# Base images are pinned by DIGEST as well as tag. `maven:3.9-eclipse-temurin-17`
# in particular floats across Maven patch and base-OS releases, so the tag alone
# does not describe the bytes a rebuild pulls. Dependabot's docker ecosystem
# (.github/dependabot.yml) bumps the tag and the digest together.
FROM maven:3-eclipse-temurin-26@sha256:166ca19b6b5fe1e924ab2d66b64ba9854c739f16210b94bbe0074b036c5c7992 AS builder
WORKDIR /build

# Third-party provider jars, fetched and checksum-verified in the builder stage
# (the Keycloak runtime image ships neither curl nor a shell worth relying on).
# This sits BEFORE the Maven build on purpose: it depends only on the ARGs, so
# a Java source change does not re-download the jar, and a GitHub outage does
# not block an SPI-only rebuild while the layer is cached.
#
# Apple Sign-in provider: klausbetz/apple-identity-provider-keycloak (Apache-2.0).
# Present in the image, dormant until a realm authors `providerId: apple`
# (docs/identity-providers.md). The version and SHA-512 below are the pinned
# supply-chain decision recorded in provider-compatibility.json; `bun run
# check:keycloak-lockstep` fails if the two disagree or if the Keycloak base
# image moves without that record being reviewed. Bump both together.
ARG APPLE_IDP_VERSION=1.17.0
ARG APPLE_IDP_SHA512=04949c18bd2819f6134f7a8fdf446e471036241c537d451e7bf1c627d8eefb1f72374d238bf0037155e725531c587065cfabf1c3f0b7f0df86fb7138effd6bba
RUN set -eu; \
    mkdir -p /build/providers; \
    curl -fsSL --retry 3 \
      -o /build/providers/apple-identity-provider-${APPLE_IDP_VERSION}.jar \
      "https://github.com/klausbetz/apple-identity-provider-keycloak/releases/download/${APPLE_IDP_VERSION}/apple-identity-provider-${APPLE_IDP_VERSION}.jar"; \
    echo "${APPLE_IDP_SHA512}  /build/providers/apple-identity-provider-${APPLE_IDP_VERSION}.jar" | sha512sum -c -

COPY pom.xml .
RUN mvn dependency:go-offline -B
COPY src ./src
RUN mvn package -B -DskipTests

FROM quay.io/keycloak/keycloak:26.5.3@sha256:5a236ae4dd8ece77490115bace15a11a4d15e9cbcf58a490b95a7da2cd71d32a
# Two separate jars on purpose: the OSF SPI is first-party code built above; the
# Apple provider is a verified third-party release. Neither is repackaged into
# the other, so each can be upgraded, audited and removed on its own.
COPY --from=builder /build/target/openshapeforge-keycloak-spi.jar /opt/keycloak/providers/
COPY --from=builder /build/providers/apple-identity-provider-*.jar /opt/keycloak/providers/
RUN /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true
