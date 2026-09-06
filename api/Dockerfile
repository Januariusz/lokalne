FROM node:22-alpine AS builder

WORKDIR /app


RUN apk add --no-cache python3 make g++

COPY package*.json ./

RUN npm ci

COPY . .
RUN npm run build


RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

# ── Production image ──────────────────────────────────────────────────────────

FROM node:22-alpine AS runner

WORKDIR /app


RUN apk add --no-cache python3 make g++ sqlite

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist


RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
