# Base images are pinned by DIGEST as well as tag. `maven:3.9-eclipse-temurin-17`
# in particular floats across Maven patch and base-OS releases, so the tag alone
# does not describe the bytes a rebuild pulls. Dependabot's docker ecosystem
# (.github/dependabot.yml) bumps the tag and the digest together.
FROM maven:3-eclipse-temurin-26@sha256:d5617b9a6307e1b51dc7c55edf09bacb66f1c91fb861949c34a3a0d4e16bd241 AS builder
WORKDIR /build
COPY pom.xml .
RUN mvn dependency:go-offline -B
COPY src ./src
RUN mvn package -B -DskipTests

FROM quay.io/keycloak/keycloak:26.5.3@sha256:5a236ae4dd8ece77490115bace15a11a4d15e9cbcf58a490b95a7da2cd71d32a
COPY --from=builder /build/target/openshapeforge-keycloak-spi.jar /opt/keycloak/providers/
RUN /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true
