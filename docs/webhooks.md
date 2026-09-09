# Webhooks, sessões e persistência

Contrato de `src/infra/baileys/services.ts` e `src/infra/webhook/outbox.ts`. A lista corresponde aos handlers deste serviço; eventos adicionais existentes na biblioteca não são automaticamente encaminhados.

## Entrega e envelope

Configure `WEBHOOK_URL` e `WEBHOOK_SECRET`. No atendimento local, use `http://localhost:3000/api/webhooks/whatsapp`; o segredo, com pelo menos 32 caracteres, deve ser igual no backend. Entregas usam POST JSON com `Content-Type: application/json`, `X-Webhook-Secret` e `X-Webhook-Id`. O ID do cabeçalho corresponde a `id` no corpo:

```json
{
  "id": "identificador-unico-do-evento",
  "timestamp": "2026-09-07T12:00:00.000Z",
  "event": "messages.upsert",
  "instance": {
    "owner": "1",
    "instanceName": "atendimento@1",
    "connectionStatus": "ONLINE",
    "instanceJid": "5511999999999@s.whatsapp.net"
  },
  "data": [
    {
      "key": {
        "id": "ID-DA-MENSAGEM",
        "remoteJid": "123456789@lid",
        "remoteJidAlt": "5511888888888@s.whatsapp.net",
        "fromMe": false
      },
      "message": {"conversation": "Olá"},
      "messageType": "conversation",
      "messageTimestamp": 1788782400,
      "pushName": "Contato"
    }
  ]
}
```

`instance` inclui `owner`, `instanceName`, `connectionStatus`, `instanceJid` quando conhecido e `profilePictureUrl` opcional. Não contém socket, token ou Signal keys. `timestamp` é o instante de criação do evento, não a data da mensagem. `data` mantém o formato de cada evento. Bytes usam BufferJSON (`{type:"Buffer",data:"BASE64"}`), e BigInt usa string decimal. Consumidores que reconstruam protobufs precisam reviver os buffers.

## Conexão

| Evento | `data` | Significado |
| --- | --- | --- |
| `qrcode.updated` | `{qrCode:"data:image/png;base64,..."}` | Novo QR. |
| `qrcode.limit` | `{qrCodeLimit:number}` | Limite atingido; socket para e aguarda reconexão explícita. |
| `pairingcode.updated` | `{pairingCode:string}` | Código quando a criação informou phoneNumber. |
| `pairingcode.limit` | `{qrCodeLimit:number}` | Limite de ciclos no pareamento por código. |
| `connection.connecting` | `{connection:"connecting"}` | Ainda OFFLINE. |
| `connection.open` | `{connection:"open"}` | Socket ONLINE; QR/código deixam de valer. |
| `connection.close` | `{reason:number\|null}` | Falha transitória; reconexão limitada. |
| `connection.removed` | `{reason:number\|null}` ou `{}` | Falha terminal/logout ou exclusão explícita. |
| `connection.error` | `{event:string,error:"EVENT_PROCESSING_FAILED"}` | Falha de persistência/processamento; socket pausado e status OFFLINE. Não expõe erro privado. |

`creds.update` persiste autenticação e nunca publica credenciais. Use o evento terminal além do status do snapshot para identificar a remoção. Falha antes de persistir um evento pode exigir ressincronização do histórico pelo WhatsApp; pausar o socket evita continuar silenciosamente com persistência quebrada.

## Histórico, contatos e grupos

| Evento | `data` |
| --- | --- |
| `contacts.set` | Contact[] do lote de histórico. |
| `chats.set` | Chat[] do lote de histórico. |
| `messages.set` | WAMessage[] serializadas, com messageType. |
| `messaging-history.progress` | Contrato versionado com runId, sequence, phase, expectedChunks, expected, processedBatches e provider. Veja [progresso da sincronização](history-sync.md). |
| `contacts.upsert`, `contacts.update` | Lista de contatos completos/parciais: id, name?, notify?, verifiedName?, lid?, phoneNumber? e outros campos recebidos. |
| `chats.upsert`, `chats.update` | Lista de conversas/alterações, incluindo id e campos recebidos como arquivamento. |
| `chats.delete` | Jid[]. |
| `lid-mapping.update` | `{lid:string,pn:string}`. |
| `groups.upsert`, `groups.update` | GroupMetadata[] completos/parciais. |
| `group-participants.update` | `{id,author,authorPn?,authorUsername?,participants:GroupParticipant[],action}`. |
| `group.join-request` | `{id,author,authorPn?,authorUsername?,participant,participantPn?,action,method}`. |

LID e telefone são identificadores alternativos. `key.remoteJidAlt` e `key.participantAlt` preservam o outro endereço quando conhecido. Contatos Baileys 7 usam `id` preferido, `phoneNumber` quando o ID é LID e `lid` quando é telefone. Signal keys incluem categorias como lid-mapping, device-list e tctoken; caches não substituem persistência.

## Mensagens e alterações

| Evento | `data` | Atendimento |
| --- | --- | --- |
| `messages.upsert` | WAMessage[] com messageType e timestamp normalizado. O wrapper nativo `{messages,type}` não é encaminhado. | Upsert por instância/ID e união de JID/LID. |
| `send.message` | Lista com a WAMessage retornada por sock.sendMessage. | Não duplica eventual messages.upsert. |
| `messages.update` | `[{key,update}]`; status, message, pollUpdates e pollVotes calculados quando há mensagem original da enquete. | Status, edição e exclusão; enquetes não têm tela própria. |
| `messages.delete` | `{keys:WAMessageKey[]}` ou `{jid,all:true}`. | Tombstone oculta conteúdo/mídia e preserva auditoria no banco do atendimento. |
| `messages.reaction` | `[{key,reaction}]`; key é a mensagem alvo; reaction contém key do autor, text e senderTimestampMs. | Última reação por autor, respeitando timestamp. Texto vazio remove. |
| `message-receipt.update` | `[{key,receipt}]`; receipt pode conter userJid, receiptTimestamp, readTimestamp, playedTimestamp. | Guarda confirmação mesmo antes da mensagem. |
| `messages.media-update` | `[{key,media?:{ciphertext,iv},error?}]`. | Nova tentativa da fila/atualização quando aplicável. |

Revogação e edição também podem chegar em protocolo: `message.protocolMessage.type=0` (REVOKE) com key alvo; tipo 14 (MESSAGE_EDIT) com key, editedMessage e timestampMs. `messages.update` com message:null significa exclusão. Aplique ao alvo, sem criar uma bolha vazia. Distribuição de chaves e protocolos internos não viram mensagens comuns.

Status nativo Baileys: 0 ERROR, 1 PENDING, 2 SERVER_ACK, 3 DELIVERY_ACK, 4 READ, 5 PLAYED. O backend converte para o formato legado: 3, 0, 1, 2, 100, 100, respectivamente. Essas numerações não são intercambiáveis.

## Eventos sem tela específica

| Evento | `data` |
| --- | --- |
| `presence.update` | `{id,presences:{[participant]:{lastKnownPresence,lastSeen?}}}`. |
| `blocklist.set` | `{blocklist:Jid[]}`. |
| `blocklist.update` | `{blocklist:Jid[],type:"add"\|"remove"}`. |
| `call` | `[{chatId,from,callerPn?,isGroup?,groupJid?,id,date,isVideo?,status,offline,latencyMs?}]`. |
| `labels.edit` | `{id,name,color,deleted,predefinedId?}`. |
| `labels.association` | `{association,type:"add"\|"remove"}`; association contém type label_jid ou label_message, chatId, labelId e messageId para mensagem. |
| `newsletter.reaction` | `{id,server_id,reaction:{code?,count?,removed?}}`. |
| `newsletter.view` | `{id,server_id,count}`. |
| `newsletter-participants.update` | `{id,author,user,new_role,action}`. |
| `newsletter-settings.update` | `{id,update}`. |

O serviço preserva essas estruturas e não cria módulos de bot, chamadas, etiquetas ou canais no frontend. Eventos não reconhecidos pelo backend do atendimento recebem confirmação com ignored:true.

## Fila durável

`WEBHOOK_QUEUE=true` é o padrão. O evento é gravado antes da tentativa HTTP, com arquivo temporário exclusivo, fsync e rename atômico. ID e corpo são reutilizados nos retries. HTTP 2xx confirma; falha de rede, timeout ou outro HTTP agenda retry. Redirecionamentos não são seguidos.

| Configuração | Padrão | Uso |
| --- | --- | --- |
| WEBHOOK_QUEUE_DIR | ./webhook-queue | Diretório privado persistente. |
| QUEUE_INTERVAL | 0.1 | **Minutos**: seis segundos por ciclo/base de retry. |
| WEBHOOK_TIMEOUT_MS | 10000 | Timeout de tentativa. |
| WEBHOOK_MAX_ATTEMPTS | 30 | Limite antes de dead-letter. |
| WEBHOOK_CONCURRENCY | 4 | Instâncias diferentes em paralelo; ordenação por instância. |

Atraso cresce exponencialmente até uma hora. Um evento pendente impede os seguintes da mesma instância naquele ciclo. Inválidos ficam em dead-letter/*.invalid; tentativas esgotadas em dead-letter/*.json. `GET /webhooks/queue` informa contagens; `POST /webhooks/queue/replay` retoma somente JSONs válidos, zerando tentativas e preservando ID. Arquivos antigos são adaptados com ID estável; targetUrl antigo é ignorado em favor da configuração atual.

Arrays grandes em data são divididos em chunks de até 100 itens e 900.000 bytes de JSON UTF-8, reservando espaço para o envelope. Um item individual acima desse limite causa falha explícita de processamento; não é descartado silenciosamente. Cada chunk recebe seu ID e pode ser repetido independentemente. Os eventos de histórico `.set` também levam `history:{runId,startedAt,batchId,chunkId}` no envelope, preservando `data` como array. Um POST não representa necessariamente o histórico inteiro.

Uma entrega esgotada vai para dead-letter e deixa de bloquear eventos posteriores. Por isso, `phase:waiting` sozinho não confirma importação no receptor: compare os chunks recebidos com `expectedChunks`, inclusive de runs anteriores. Replay conserva os IDs do evento e do chunk. Detalhes e limites estão no [contrato de sincronização](history-sync.md).

Há possibilidade de duplicatas: o consumidor pode ter confirmado no banco e perdido a resposta HTTP. Deduplicate por ID do evento e/ou chave de negócio owner/instanceName/messageId; aceite alterações fora de ordem. Fila de arquivos e PostgreSQL são armazenamentos separados, sem transação distribuída. Falhas entre persistir e enfileirar podem exigir reconciliação; syncPending sinaliza esse caso em envios HTTP quando detectado.

`WEBHOOK_QUEUE=false` usa HTTP direto, sem retry persistente. WEBHOOK_URL vazio desabilita emissão. Encerramento normal drena processamento, gravações de auth e tentativas em andamento; eventos restantes em disco retomam no próximo início.

## Armazenamento e operação

PostgreSQL armazena mensagens, contatos, conversas e autenticação. A chave interna é owner/instanceName; consultas de mídia/respostas/ações não usam somente ID sem instância. `AUTH_STORE=database` grava credenciais/Signal keys em AuthState. `AUTH_STORE=filesystem` usa snapshot atômico local. Preserve o diretório de sessões em ambos, para inventário/importação.

Credenciais antigas em arquivos são importadas quando o destino ainda não as contém; arquivos corrompidos não são substituídos silenciosamente. Chaves owner_instanceName só migram quando o inventário não é ambíguo. Reinício/reconexão preservam histórico; logout invalida autenticação; DELETE /instances/delete/... remove explicitamente dados locais. O banco do atendimento mantém sua auditoria independente.

Use **um processo por conjunto de sessões e diretório de fila**. Mutexes, sockets, timers e caches são locais; PM2 cluster ou réplicas sobre a mesma sessão exigem coordenação distribuída. Reconexões transitórias continuam com espera crescente limitada a 30 segundos; falhas terminais aguardam novo pareamento/intervenção. Consulte a [revisão de escalabilidade](scalability-review.md) antes de aumentar concorrência ou réplicas.

Falhas de armazenamento da fila agora informam PID, fase, código I/O e diretório, sem conteúdo dos eventos ou credenciais. `EACCES`, `ENOTDIR` e `ENOSPC`, por exemplo, distinguem permissões, caminho inválido e disco cheio. Esses erros são separados do retry normal por falha HTTP no destino. Veja [o diagnóstico de inicialização](startup.md) quando mensagens de retry aparecem junto de `EADDRINUSE`.

Testes usam sockets, HTTP e repositórios controlados. Parear uma conta e entregar mensagens reais exige autorização do titular pelo aplicativo WhatsApp. Teste local bem-sucedido não significa sessão real conectada.
