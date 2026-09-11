# ZapToBox WhatsApp API

Serviço TypeScript/ESM para sessões WhatsApp, mensagens, grupos, perfil, privacidade, mídia e webhooks. Usa Node.js 24+, PostgreSQL/Prisma e **Baileys 7.0.0-rc14**, fixado no lockfile. Essa versão é uma **release candidate**, não a versão final 7.0.0. Referências: [release oficial](https://github.com/WhiskeySockets/Baileys/releases/tag/v7.0.0-rc14) e [migração para Baileys 7](https://baileys.wiki/migration/v7).

O frontend do atendimento permanece em `../ZapToBox novo - Front`, e a API de contas/conversas em `../ZapToBox novo - Back`. Este serviço mantém os sockets Baileys e não serve páginas HTML.

## Executar localmente

Instale Node.js 24+ e disponibilize um banco PostgreSQL para a aplicação. Na primeira configuração, copie `.env.example` para `.env`; preserve um `.env` existente.

```powershell
cd 'D:\ZapToBox\ZapToBox-Whatsapp-Api'
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Preencha os valores antes de iniciar:

| Variável | Valor/uso |
| --- | --- |
| `DATABASE_URL` | Conexão PostgreSQL com usuário, senha e banco próprios. |
| `HOST` | `127.0.0.1` no desenvolvimento local. |
| `PORT` | `3001`, deixando 3000 para o backend do atendimento. |
| `JWT_TOKEN` | Segredo aleatório com pelo menos 32 caracteres. Bearer administrativo, igual a `WPP_API_TOKEN` no backend. |
| `AUTH_STORE` | `database` por padrão; alternativa local `filesystem`. |
| `WEBHOOK_URL` | `http://localhost:3000/api/webhooks/whatsapp`. |
| `WEBHOOK_SECRET` | Segredo aleatório com pelo menos 32 caracteres, igual ao configurado no backend. |
| `WEBHOOK_QUEUE` | `true` para preservar eventos e repetir falhas. |
| `TRUSTED_MEDIA_ORIGINS` | Origens exatas do backend ZapToBox autorizadas para anexos (ex.: `https://backend.zaptobox.pro`). |

Depois de configurar banco e segredos:

```powershell
npm run db:migrate
npm run build
npm start
```

`npm run dev` executa TypeScript com recarga. `npm run build` gera o Prisma Client e compila. `GET http://localhost:3001/health` verifica o processo; `/health/ready` exige Bearer e verifica inicialização/banco, sem garantir WhatsApp online. Para uma base antiga, faça backup e revise as migrations antes de aplicar; não apague credenciais para resolver falha de atualização.

Se ocorrer **EADDRINUSE**, execute `npm run diagnose` no servidor afetado. Há uma execução ocupando a porta; `build:start` não reinicia processos existentes. Com PM2 como único supervisor, `npm run build:pm2` usa início/reinício coordenado em uma instância. Em painéis de hospedagem, use a ação de reiniciar do próprio painel. Veja [inicialização, conflito de porta e avisos npm](docs/startup.md).

O lockfile inclui correções de dependências identificadas na atualização: `link-preview-js` 5.0.0 e override de `deepmerge-ts` 8.0.2. Em 07/09/2026, `npm audit` não apontou vulnerabilidades. Use `npm ci` para reproduzir as versões verificadas.

O `docker-compose.yml` mantém PostgreSQL 16 e volumes persistentes. Consulte os valores do `.env.example` antes de iniciar containers. Uma atualização de imagem PostgreSQL entre versões principais precisa de migração própria; os testes adicionais em PostgreSQL 18 não alteram automaticamente a versão de um volume existente.

No backend de atendimento, configure `WPP_API_URL=http://localhost:3001` e o token correspondente. Texto usa `POST /messages/sendText/:owner/:instanceName` com `{remoteJid,text}`; não é preciso configurar rota alternativa.

Envios e edições de texto incluem prévias de links quando o site disponibiliza uma imagem compatível. A API prepara a miniatura JPEG com consultas restritas a endereços públicos, prazo total de 6 segundos e limites de download/processamento. O cache é isolado por conexão. Sites privados, indisponíveis ou incompatíveis resultam em texto sem prévia, sem impedir nem repetir o envio. Veja os [limites e formatos das prévias](docs/api.md#mensagens).

## Pareamento e contratos

Crie uma conexão pelo frontend ou por `POST /instances/create`, conforme a [documentação HTTP completa](docs/api.md). A rota exige `Idempotency-Key` UUID v4 e é idempotente para a mesma identidade `owner/instanceName`; `GET /instances/status/:owner/:instanceName` permite reconciliação exata sem listar outras sessões. A nova sessão precisa ser pareada por QR no aplicativo WhatsApp. A API também aceita `phoneNumber` para solicitar código. Sucesso HTTP na criação não significa conta online: aguarde `connection.open`.

Signal keys, histórico e contatos são persistidos por instância. Reiniciar e reconectar preservam histórico. Sessões válidas são restauradas automaticamente após reiniciar, inclusive pareamentos por QR Code cujas credenciais Baileys mantêm `registered: false`; veja [restauração após atualizar](docs/startup.md#restauração-automática-das-conexões-após-atualizar--10092026). Webhooks usam gravação atômica, retries e dead-letter; veja [eventos, payloads e operação da fila](docs/webhooks.md).

Os [contratos de nomes, leitura e mídia sob demanda](docs/contact-names-and-demand.md) preservam a prioridade dos nomes salvos no celular, a origem das alterações e os timestamps durante reimportações. A atualização exige a migration de metadata dos contatos.

A [recuperação de conexão](docs/connection-recovery.md) preserva sessões válidas e repete quedas sem depender do painel. Há supervisão compartilhada para transportes fechados sem notificação e autenticações travadas, espera maior para conflitos/recusas e retenção de gravações Signal pendentes durante falhas temporárias do armazenamento. Logout confirmado encerra as tentativas. Publique também o backend e as interfaces atualizadas para manter o status consistente.

O [progresso de sincronização](docs/history-sync.md) identifica recebimento e importação de lotes, preservando contagens e reentregas. O percentual informado pelo WhatsApp pertence à etapa atual; não representa todo o histórico nem o download das mídias.

## Verificação e limites

```powershell
npm run typecheck
npm test
```

Os testes usam sockets e provedores controlados, e há validação de persistência em PostgreSQL e do fluxo HTTP entre backend, API e webhook. Não pareiam uma conta nem enviam mensagens reais. Fotos/anexos de saída precisam estar em URLs públicas válidas; não há transcodificação automática. A configuração do Compose foi validada; o build de container depende de um daemon Docker ativo.

Testes com PostgreSQL são opcionais: configure `QA_DATABASE_URL` para um banco **descartável**, local e com nome iniciado por `qa_`, já migrado. O teste integrado também usa `QA_BACKEND_PATH` com o caminho do backend previamente compilado. Sem essas variáveis, esses casos são ignorados; os testes unitários continuam disponíveis. Não use o banco da aplicação como banco de QA.

Execute um processo por conjunto de sessões e diretório de fila. PM2 pode supervisioná-lo, mas cluster/réplicas precisam de coordenação adicional. Preserve banco, sessões e fila em volumes persistentes. O atendimento oferece envio de texto e leitura de mídia; outras rotas documentadas ficam disponíveis para clientes autenticados, sem criar telas de bots ou financeiro.
