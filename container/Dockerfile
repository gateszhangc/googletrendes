FROM mcr.microsoft.com/playwright:v1.53.0-jammy

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl jq ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /work
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY container/ ./container/

CMD ["node", "container/test-iproyal-explore.mjs"]
