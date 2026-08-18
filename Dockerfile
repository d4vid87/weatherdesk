# The dashboard with no desktop: the LAN server, the hub listener and the archive, for a house
# whose only always-on machine is a NAS or a Pi.
#
# Built without the `gui` feature, so no Tauri, no GTK and no WebKit are anywhere in this image.
FROM rust:1-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY site ./site
COPY src-tauri ./src-tauri
WORKDIR /src/src-tauri
RUN cargo build --release --no-default-features --bin weatherdesk

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/src-tauri/target/release/weatherdesk /usr/local/bin/weatherdesk
# One directory holds the settings blob and the observation archive.
ENV WD_DATA_DIR=/data
VOLUME /data
EXPOSE 8088
EXPOSE 50222/udp
# IMPORTANT: run with `network_mode: host` on Linux. The Tempest hub broadcasts to the subnet,
# and a broadcast does not cross a bridged Docker network no matter how many ports are published.
ENTRYPOINT ["/usr/local/bin/weatherdesk", "--headless"]
