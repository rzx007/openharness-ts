FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    ripgrep \
    util-linux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
