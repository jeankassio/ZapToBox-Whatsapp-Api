############################################
# BASE IMAGE
############################################
FROM node:22-slim AS base

RUN apt-get update && apt-get install -y \
    git \
    openssh-client \
    ffmpeg \
    --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /zaptobox


############################################
# BUILDER
############################################
FROM base AS builder

WORKDIR /zaptobox

RUN mkdir -p /root/.ssh && \
    ssh-keygen -t rsa -b 4096 -C "docker@container" -N "" -f /root/.ssh/id_rsa && \
    chmod 600 /root/.ssh/id_rsa && \
    touch /root/.ssh/known_hosts && \
    ssh-keyscan github.com >> /root/.ssh/known_hosts

ENV GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no"


COPY package*.json ./ 
COPY tsconfig.json ./ 
COPY prisma ./prisma
COPY .env.example ./.env

RUN npm install --force

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

COPY --from=builder /zaptobox/dist ./dist
COPY --from=builder /zaptobox/prisma ./prisma
COPY --from=builder /zaptobox/node_modules ./node_modules
COPY --from=builder /zaptobox/package*.json ./ 

RUN mkdir -p /zaptobox/sessions

ENV DOCKER_ENV=true

EXPOSE 3000

CMD ["node", "dist/main.js"]
