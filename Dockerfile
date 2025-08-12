# Minimal, multi-arch base
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=UTC \
    NODE_MAJOR=20

# System deps, Node.js 20 (NodeSource), MySQL client, and basic tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg lsb-release \
    tar gzip bash coreutils && \
    # NodeSource repo for Node 20
    install -d -m 0755 /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends nodejs && \
    # Ubuntu 24.04 ships MySQL 8 client as 'mysql-client'
    apt-get install -y --no-install-recommends mysql-client && \
    # Cleanup
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps first for better layer caching
COPY package.json ./
RUN npm ci --omit=dev

# Copy source and entrypoint
COPY src/ ./src/
COPY scripts/entrypoint.sh ./scripts/entrypoint.sh
RUN chmod +x ./scripts/entrypoint.sh

ENTRYPOINT ["./scripts/entrypoint.sh"]
