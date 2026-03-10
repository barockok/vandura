FROM node:22-alpine AS build
WORKDIR /app
RUN npm install -g @anthropic-ai/claude-code
# Pre-cache MCP server packages so npx doesn't need to download them at runtime
# (Claude Code has a short MCP startup timeout that npx downloads can exceed)
RUN npx -y @modelcontextprotocol/server-postgres --help 2>/dev/null || true && \
    npx -y @leval/mcp-grafana --help 2>/dev/null || true
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM build AS test
RUN npm ci --include=dev
CMD ["npm", "test"]

FROM node:22-alpine AS production
WORKDIR /app
RUN addgroup -S vandura && adduser -S vandura -G vandura
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/config ./config
COPY --from=build /app/src/db/migrations ./src/db/migrations
USER vandura
EXPOSE 3000
CMD ["node", "dist/index.js"]
