############################################
# BASE IMAGE
############################################
FROM node:22-slim AS base

RUN apt-get update && apt-get install -y \
    git \
    ffmpeg \
    openssl \
    --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /zaptobox


############################################
# DEPENDENCIES
############################################
FROM base AS dependencies

WORKDIR /zaptobox

COPY package*.json ./

RUN npm ci --force --only=production && \
    npm cache clean --force


############################################
# BUILDER
############################################
FROM base AS builder

RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/ \
 && git config --global url."https://github.com/".insteadOf git@github.com:

WORKDIR /zaptobox

COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma

RUN npm ci --force

COPY src ./src

RUN npx prisma generate

RUN npm run build


############################################
# PRODUCTION IMAGE
############################################
FROM base AS production

WORKDIR /zaptobox

LABEL com.api.version="1.1.0"
LABEL com.api.maintainer="https://github.com/jeankassio"
LABEL com.api.repository="https://github.com/jeankassio/ZapToBox-Whatsapp-Api"
LABEL com.api.issues="https://github.com/jeankassio/ZapToBox-Whatsapp-Api/issues"

COPY --from=dependencies /zaptobox/node_modules ./node_modules
COPY --from=builder /zaptobox/dist ./dist
COPY --from=builder /zaptabox
