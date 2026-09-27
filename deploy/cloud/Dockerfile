FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
COPY bin ./bin
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git bash ca-certificates tini && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@2.1.283 --no-audit --no-fund
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/bin ./bin
COPY --from=build /app/package.json ./package.json
COPY deploy/cloud/entrypoint.sh /app/entrypoint.sh
RUN chmod 755 /app/entrypoint.sh && mkdir /workspace && chown node:node /workspace
USER node
ENV NODE_ENV=production
EXPOSE 4600
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:4600/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["--host", "0.0.0.0", "--port", "4600"]
