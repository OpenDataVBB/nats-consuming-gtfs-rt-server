# syntax=docker/dockerfile:1.6
# ^ needed for ADD --checksum=…

FROM node:22-alpine as builder
WORKDIR /app

RUN npm install --production

# ---

FROM node:22-alpine
WORKDIR /app

LABEL org.opencontainers.image.title="nats-consuming-gtfs-rt-server"
LABEL org.opencontainers.image.description="Reads DIFFERENTIAL-mode GTFS Realtime data from NATS message broker, and serves it as FULL_DATASET via HTTP."
LABEL org.opencontainers.image.authors="Verkehrsverbund Berlin Brandenburg <info@vbb.de>"

# install dependencies
COPY --from=builder /app/node_modules ./node_modules

# add source code
ADD . /app

# CLI smoke test
RUN ./cli.js --help >/dev/null

ENTRYPOINT [ "./cli.js"]
