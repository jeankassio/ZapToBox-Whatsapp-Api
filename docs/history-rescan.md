# Resincronização do histórico armazenado

Antes de usar os endpoints, aplique a migration `20260908000000_history_rescan` com `npm run db:migrate` e gere/compile com `npm run build`. O trabalho usa PostgreSQL e a outbox de webhooks já configurada. A implementação não executa migrations automaticamente.

`POST /instances/history-rescan/:owner/:instanceName`, com Bearer token e `Idempotency-Key: UUID-v4`, responde HTTP 202:

```json
{"success":true,"data":{"jobId":"UUID","runId":"UUID","status":"queued","phase":"contacts","counts":{"contacts":0,"chats":0,"messages":0},"completionMeaning":"enqueued"}}
```

`owner` é o identificador da instância no sistema que consome a API. No ZapToBox ele corresponde a `tbl_instances._id`, não ao usuário proprietário. O token deve autorizar exatamente esse owner/nome ou ser o token administrativo. Repetir a mesma chave devolve o mesmo trabalho; outra chave durante um trabalho ativo retorna 409.

`GET /instances/history-rescan/:owner/:instanceName/:jobId` consulta o trabalho dentro do mesmo escopo. A resposta inclui `status` (`queued`, `running`, `completed`, `failed`), `phase`, `counts`, `scanned`, `available`, `chunks`, datas, `attempts` e `errorCode`. `completed` significa que todos os lotes foram entregues à outbox. A entrega HTTP, os lotes em dead-letter e a importação/mídias no consumidor têm acompanhamento separado.

O trabalho percorre contatos, chats e mensagens por cursor de ID, limitado aos maiores IDs capturados na criação. Itens recebidos depois continuam pelo fluxo normal. As mensagens internas de protocolo que não aparecem em conversas não são exportadas; edições e revogações seguem o formato normal. `available` conta os registros armazenados no início; `scanned` conta os registros lidos e `counts` os itens efetivamente enfileirados. Alterações/exclusões da fonte durante a leitura podem mudar o conteúdo ainda não percorrido.

Mensagens armazenadas com a revisão atual preservam a indicação `edited: true` durante o reenvio. Novas edições mantêm a data original de envio já conhecida, para evitar reordenar conversas numa reconstrução. Datas originais sobrescritas por versões antigas da API não podem ser recuperadas apenas desse registro.

Cada página pendente é congelada no PostgreSQL antes de entrar na outbox. Reinícios e falhas podem repetir uma entrega, sempre com o mesmo identificador do evento, `runId`, `chunkId` e conteúdo. O consumidor deve manter sua deduplicação transacional por lote. O ZapToBox já faz essa deduplicação. Um indicador `messaging-history.progress` anuncia os totais conhecidos, e o último usa `phase: waiting`; não afirma que o WhatsApp forneceu todo o histórico existente no aparelho.

O produtor pausa enquanto a outbox tem 50 eventos pendentes, limita o tamanho das páginas e dos lotes e retoma após a fila escoar. Um item maior que o limite existente de webhook produz `HISTORY_ENTRY_TOO_LARGE`, sem descartá-lo nem apagá-lo da fonte. Falhas transitórias preservam a página e usam tentativas com intervalo crescente. Depois de uma falha definitiva, uma nova chave inicia uma nova leitura completa.

Nenhuma sessão, credencial ou conversa é apagada, e nenhum login, logout ou leitura de QR é solicitado. Essa ação reenvia dados que a API já armazenou; não recupera mensagens que nunca chegaram à API ou que já foram removidas dela.
