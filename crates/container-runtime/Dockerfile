FROM rust:1.78.0-bookworm AS builder

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/
RUN cargo build --locked --release -p cinatoken-container-runtime

FROM gcr.io/distroless/cc-debian12:nonroot

COPY --from=builder --chown=nonroot:nonroot /build/target/release/cinatoken-container-runtime /usr/local/bin/cinatoken-container-runtime

USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/cinatoken-container-runtime"]
