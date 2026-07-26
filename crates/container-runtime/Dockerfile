FROM rust:1.78.0-bookworm@sha256:5907e96b0293eb53bcc8f09b4883d71449808af289862950ede9a0e3cca44ff5 AS builder

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/
RUN cargo build --locked --release -p cinatoken-container-runtime

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:66aa873a4a14fb164aa01296058efd8253744606d72715e45acface073359faa

WORKDIR /
COPY --from=builder --chown=nonroot:nonroot /build/target/release/cinatoken-container-runtime /usr/local/bin/cinatoken-container-runtime

USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/cinatoken-container-runtime"]
