FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /zaptobox

FROM base AS builder
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM base AS production
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate
COPY --from=builder /zaptobox/dist ./dist
COPY tools ./tools
RUN mkdir -p sessions webhook-queue && chown -R node:node sessions webhook-queue
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
