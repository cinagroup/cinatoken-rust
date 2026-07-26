ARG SOURCE_DATE_EPOCH=0
FROM rust:1.78.0-alpine3.20@sha256:214477ec837f9bedd80be4b087fec09e3f270831979412840f3f6c38e5a0d9c1 AS builder

ARG SOURCE_DATE_EPOCH
ENV CARGO_BUILD_TARGET=x86_64-unknown-linux-musl \
    CARGO_INCREMENTAL=0 \
    SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/
RUN cargo build --locked --release -p cinatoken-container-runtime \
    && readelf -l /build/target/x86_64-unknown-linux-musl/release/cinatoken-container-runtime \
        > /tmp/cinatoken-container-runtime-program-headers \
    && ! grep -q INTERP /tmp/cinatoken-container-runtime-program-headers \
    && install -D -m 0755 /build/target/x86_64-unknown-linux-musl/release/cinatoken-container-runtime \
        /runtime-root/usr/local/bin/cinatoken-container-runtime \
    && find /runtime-root -exec touch -d "@${SOURCE_DATE_EPOCH}" {} +

FROM gcr.io/distroless/static-debian12:nonroot@sha256:f5b485ea962d9bd1186b2f6b3a061191539b905b82ec395de78cbfae51f20e35

WORKDIR /
COPY --from=builder --chown=0:0 /runtime-root/ /

USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/cinatoken-container-runtime"]
