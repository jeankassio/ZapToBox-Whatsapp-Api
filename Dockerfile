############################################
# BASE IMAGE
############################################
FROM node:22-slim AS base

RUN apt-get update && apt-get install -y \
    git \
    ffmpeg \
    --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /zaptobox


############################################
# BUILDER
############################################
FROM base AS builder

WORKDIR /zaptobox

COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma

RUN npm install --force

COPY src ./src

RUN npx prisma generate

RUN npm run build


############################################
# PRODUCTION IMAGE
############################################
FROM base AS production

WORKDIR /zaptobox

LABEL com.api.version="1.0.0"
LABEL com.api.maintainer="https://github.com/jeankassio"
LABEL com.api.repository="https://github.com/jeankassio/ZapToBox-Whatsapp-Api"
LABEL com.api.issues="https://github.com/jeankassio/ZapToBox-Whatsapp-Api/issues"

COPY --from=builder /zaptobox/dist ./dist
COPY --from=builder /zaptobox/prisma ./prisma
COPY --from=builder /zaptobox/node_modules ./node_modules
COPY --from=builder /zaptobox/package*.json ./

RUN mkdir -p /zaptobox/sessions

ENV DOCKER_ENV=true

EXPOSE 3000

CMD ["node", "dist/main.js"]
