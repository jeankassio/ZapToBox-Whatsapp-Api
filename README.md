
<div align="center">

# ZapToBox Whatsapp Api

[![jeankassio - ZapToBox-Whatsapp-Api](https://img.shields.io/static/v1?label=jeankassio&message=ZapToBox-Whatsapp-Api&color=darkgreen&logo=github)](https://github.com/jeankassio/ZapToBox-Whatsapp-Api "Go to GitHub repo")
[![stars - ZapToBox-Whatsapp-Api](https://img.shields.io/github/stars/jeankassio/ZapToBox-Whatsapp-Api?style=social)](https://github.com/jeankassio/ZapToBox-Whatsapp-Api)
[![forks - ZapToBox-Whatsapp-Api](https://img.shields.io/github/forks/jeankassio/ZapToBox-Whatsapp-Api?style=social)](https://github.com/jeankassio/ZapToBox-Whatsapp-Api)
  

[![Support](https://img.shields.io/badge/-Grupo%20Whatsapp-darkgreen?style=for-the-badge&logo=whatsapp)](https://chat.whatsapp.com/Deus9QmrfZlJaZIf46F129)


[![Support](https://img.shields.io/badge/Buy%20me%20coffe-PayPal-blue?style=for-the-badge)](https://paypal.me/JAlmeidaCheib)
[![Support](https://img.shields.io/badge/Buy%20me%20coffe-Pix-darkturquoise?style=for-the-badge)](#pix)
</div>

<p align="center"> 
<img src="https://img.shields.io/badge/WhatsApp-Baileys%20Core-green?style=for-the-badge" /> 
<img src="https://img.shields.io/badge/TypeScript-5.x-blue?style=for-the-badge" /> 
<img src="https://img.shields.io/badge/Node.js-18%2B-43853D?style=for-the-badge&logo=node.js&logoColor=white" /> 
<img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" /> 

<img alt="background github" src="https://github.com/user-attachments/assets/759f09c2-a49a-4e57-a2bc-2e995fc21fb8" />

</p>

REST API platform for integrating systems with WhatsApp with stability, multi-instance management, message sending, and full webhook event streaming.
Designed for enterprise automation, bots, SaaS platforms, CRMs, ERPs, and large-scale integrations.

# Overview

ZapToBox WhatsApp API is an advanced REST platform built on top of Baileys, enabling fast and stable integration between applications and WhatsApp.

#### The project supports:

- Multi-instance session management

- File-system based authentication (/sessions/{{owner}}/{{instanceName}})

- Full event webhook streaming

- High-performance message persistence

- All Baileys methods exposed through endpoints

- Scalable architecture using DDD (Domain Driven Design)

- Full TypeScript backend with Prisma ORM

- Automatic reconnection and failure handling

- Connection with QrCode and Pairing Code


# Features

### Multi-instance Session Architecture

Each instance is fully isolated using the structure:

```bash
/sessions/{owner}/{instanceName}
```

This enables:

- Multiple authenticated devices per system

- Multi-user/multi-tenant architecture

- Stateless REST integration across environments

### All Baileys Functionalities Exposed via API

#### The platform exposes every usable operation from Baileys, including:

- Messages 

- Media

- Chat 

- Group

- Profile

- Privacy


### Webhook Event Streaming

#### All supported Baileys events are forwarded to your system in real-time, they are:

- messaging-history.set
- chats.upsert
- chats.update
- chats.delete
- lid-mapping.update
- presence.update
- contacts.upsert
- contacts.update
- messages.upsert
- messages.update
- messages.delete
- messages.media-update
- messages.reaction
- message-receipt.update
- groups.upsert
- groups.update
- group-participants.update
- group.join-request
- blocklist.set
- blocklist.update
- call
- labels.edit
- labels.association
- newsletter.reaction
- newsletter.view
- newsletter-participants.update
- newsletter-settings.update

#### And as additional webhook events:

- chats.set
- messages.set
- qrcode.updated
- qrcode.limit
- pairingcode.updated
- pairingcode.limit
- connection.open
- connection.close
- connection.removed


## Status de Mensagem do WhatsApp (Baileys)

The message status returned by Baileys is an integer (`status`). For quick reference when integrating it into your project, see below how to map it:

| Número | String        
|--------|---------------
| 0      | ERROR         |
| 1      | PENDING       |
| 2      | SENT          |
| 3      | DELIVERED     |
| 4      | READ          |
| 5      | PLAYED        |


# Project Structure

- `/prisma`
    - `/migrations`
        - `...`
    - `schema.prisma`
- `/src`
    - `/core`
        - `/connection`
            - `prisma.ts`
        - `/repositories`
            - `instances.ts`
    - `/infra`
        - `/baileys`
            - `services.ts`
        - `/config`
            - `env.ts`
        - `/http`
            - `/controllers`
                - `chat.ts`
                - `group.ts`
                - `instances.ts`
                - `media.ts`
                - `messages.ts`
                - `privacy.ts`
                - `profile.ts`
            - `/routes`
                - `chat.ts`
                - `group.ts`
                - `instances.ts`
                - `media.ts`
                - `messages.ts`
                - `privacy.ts`
                - `profile.ts`
        - `/mappers`
            - `contactMapper.ts`
            - `messageMapper.ts`
        - `/state`
            - `auth.ts`
            - `sessions.ts`
        - `/webhook`
            - `queue.ts`
    - `/shared`
        - `constants.ts`
        - `types.ts`
        - `utils.ts`
    - `main.ts`
- `/docs`
- `.env.example`
- `.gitignore`
- `docker-compose.yml`
- `Dockerfile`
- `LICENSE`
- `package.json`
- `prisma.config.ts`
- `README.md`
- `tsconfig.json`


# Installation

### Clone the repository

```bash
git clone https://github.com/jeankassio/ZapToBox-Whatsapp-Api.git
cd ZapToBox-Whatsapp-Api
```

### Install dependencies

```bash
npm install
```

### Environment configuration

#### Rename .env.example to .env

```bash
cp .env.example .env
```
##### Please fill in all the information correctly within the .env file before proceeding, especially the PostgreSQL connection URL.

### Deploy Prisma

```bash
npx prisma migrate deploy
```
##### Confirm and proceed


# Running 

## Development

```bash
npm run dev
```

## Production (auto build)

```bash
npm run start
```

## Production (PM2)

### build

```bash
npm run build
```
### run

```bash
npm run start:pm2

//optionals:
pm2 save
pm2 startup
```

## Docker Deploy

### Build the image

```bash
docker build -t zaptobox-whatsapp-api
```
### Run

```bash
docker run -d --name zaptobox -p 3000:3000 --env-file .env zaptobox-whatsapp-api
```

# API Docs

##### You can find complete documentation for the endpoints at:

- [Postman](https://www.postman.com/jeankassio12/zaptobox-api)

# Donate

<div align="center">
  
### Pix

<img width="40%" alt="image" src="https://github.com/user-attachments/assets/063c3bc1-36a8-4825-a6c5-f633f887f6c6" />

#### 6dcc2052-0b7c-4947-831d-46d67235416e

</div>
