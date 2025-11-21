############################################
# BASE IMAGE
############################################
FROM node:22-slim AS base

RUN apt-get update && apt-get install -y \
    git \
    ffmpeg \
    openssl \
    openssh-client \
    ca-certificates \
    --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /zaptobox


############################################
# BUILDER
############################################
FROM base AS builder

WORKDIR /zaptobox

RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/ && \
    git config --global url."https://".insteadOf git:// && \
    git config --global url."https://".insteadOf ssh:// && \
    git config --global http.sslVerify false

COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma

RUN npm install

COPY src ./src

RUN npx prisma generate

RUN npm run build


############################################
# PRODUCTION IMAGE
############################################
FROM base AS production

WORKDIR /zaptobox

LABEL com.api.version="1.1.6"
LABEL com.api.maintainer="https://github.com/jeankassio"
LABEL com.api.repository="https://github.com/jeankassio/ZapToBox-Whatsapp-Api"
LABEL com.api.issues="https://github.com/jeankassio/ZapToBox-Whatsapp-Api/issues"

RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/ && \
    git config --global url."https://".insteadOf git:// && \
    git config --global url."https://".insteadOf ssh:// && \
    git config --global http.sslVerify false

COPY package*.json ./
COPY prisma ./prisma

RUN npm install --omit=dev && \
    npx prisma generate

COPY --from=builder /zaptobox/dist ./dist

RUN mkdir -p /zaptobox/sessions

ENV DOCKER_ENV=true

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
