# Resincronização do histórico armazenado

Antes de usar os endpoints, aplique a migration `20260908000000_history_rescan` com `npm run db:migrate` e gere/compile com `npm run build`. O trabalho usa PostgreSQL e a outbox de webhooks já configurada. A implementação não executa migrations automaticamente.

`POST /instances/history-rescan/:owner/:instanceName`, com Bearer token e `Idempotency-Key: UUID-v4`, responde HTTP 202:

```json
{"success":true,"data":{"jobId":"UUID","runId":"UUID","status":"queued","phase":"contacts","counts":{"contacts":0,"chats":0,"messages":0},"completionMeaning":"enqueued","reused":false,"reuseMode":null,"waitingReason":null,"nextAttemptAt":"2026-09-09T12:00:00.000Z"}}
```

`owner` é o identificador da instância no sistema que consome a API. No ZapToBox ele corresponde a `tbl_instances._id`, não ao usuário proprietário. O token deve autorizar exatamente esse owner/nome ou ser o token administrativo. Repetir a mesma chave devolve o mesmo trabalho com `reused: true` e `reuseMode: idempotent`. Outra chave durante um trabalho ativo acompanha esse trabalho com `reuseMode: active`, mantendo `jobId`, `runId` e contadores. O mesmo vale para um produtor já `completed` cujos eventos ainda aguardam entrega na outbox. O consumidor não deve reiniciar os contadores nem repetir a preparação de mídias ao apenas acompanhar outro trabalho.

Se o histórico natural estiver recebendo/importando lotes ou ainda houver entregas de histórico sem um trabalho manual correspondente, o POST não cria um novo trabalho. Retorna HTTP 409 com `code: HISTORY_SYNC_IN_PROGRESS`. O consumidor deve manter a sincronização atual visível. Downloads e lotes são considerados ativos desde o callback de recebimento, inclusive antes de passarem pela fila de gravação. `active: true/false` no progresso natural informa a atividade observada; pausas e silêncio do provedor não são prova de que todo o histórico foi recebido.

`GET /instances/history-rescan/:owner/:instanceName/:jobId` consulta o trabalho dentro do mesmo escopo. A resposta inclui `status` (`queued`, `running`, `completed`, `failed`), `phase`, `counts`, `scanned`, `available`, `chunks`, datas, `attempts`, `errorCode`, `nextAttemptAt` e `waitingReason`. Este último pode ser `natural-history`, `webhook-backlog` ou `null`. `completed` significa que todos os lotes foram entregues à outbox; enquanto o próprio run ainda aguarda entrega, `waitingReason` será `webhook-backlog`. A entrega HTTP, os lotes em dead-letter e a importação/mídias no consumidor têm acompanhamento separado.

O trabalho percorre contatos, chats e mensagens por cursor de ID, limitado aos maiores IDs capturados na criação. Itens recebidos depois continuam pelo fluxo normal. As mensagens internas de protocolo que não aparecem em conversas não são exportadas; edições e revogações seguem o formato normal. `available` conta os registros armazenados no início; `scanned` conta os registros lidos e `counts` os itens efetivamente enfileirados. Alterações/exclusões da fonte durante a leitura podem mudar o conteúdo ainda não percorrido.

Mensagens armazenadas com a revisão atual preservam a indicação `edited: true` durante o reenvio. Novas edições mantêm a data original de envio já conhecida, para evitar reordenar conversas numa reconstrução. Datas originais sobrescritas por versões antigas da API não podem ser recuperadas apenas desse registro.

Cada página pendente é congelada no PostgreSQL antes de entrar na outbox. Reinícios e falhas podem repetir uma entrega, sempre com o mesmo identificador do evento, `runId`, `chunkId` e conteúdo. O consumidor deve manter sua deduplicação transacional por lote. O ZapToBox já faz essa deduplicação. O progresso e os metadados `history` de cada lote identificam `source: stored-history`, permitindo separar o replay manual de uma sincronização natural mesmo quando a entrega ocorre fora de ordem. Um indicador `messaging-history.progress` anuncia os totais conhecidos, e o último usa `phase: waiting` e `active: false`; não afirma que o WhatsApp forneceu todo o histórico existente no aparelho.

Os eventos usam o snapshot real da conexão com `connectionStatus: ONLINE`, `connectionState` e `connectionUpdatedAt`. A marca da conexão é guardada no JSON do trabalho e revalidada antes de cada envio. Desconexão ou troca de transporte encerra o trabalho com `HISTORY_CONNECTION_CLOSED`, preservando o histórico armazenado e impedindo a continuação de um run cancelado. Essa marca adicional não exige nova migration da API.

O produtor pausa enquanto a outbox tem 50 eventos pendentes, limita o tamanho das páginas e dos lotes e retoma após a fila escoar. Se novos lotes naturais chegarem durante o replay, o trabalho manual preserva sua página e cede a vez sem consumir tentativas. A próxima tentativa é adiada; a seleção por `nextAttemptAt` permite que outras conexões avancem. Um item maior que o limite existente de webhook produz `HISTORY_ENTRY_TOO_LARGE`, sem descartá-lo nem apagá-lo da fonte. Falhas transitórias preservam a página e usam tentativas com intervalo crescente. Depois de uma falha definitiva, uma nova chave pode iniciar uma nova leitura completa, desde que a conexão esteja online e não haja sincronização concorrente.

O acompanhamento da outbox compartilha um índice de metadados por até um segundo, sem guardar corpos das mensagens. Novos enqueues são incorporados imediatamente e cancelamentos invalidam a geração correspondente. Após uma entrega, o indicador pode permanecer pendente por esse breve intervalo conservador; não usa o tempo para afirmar conclusão do histórico.

Nenhuma sessão, credencial ou conversa é apagada, e nenhum login, logout ou leitura de QR é solicitado. Essa ação reenvia dados que a API já armazenou; não recupera mensagens que nunca chegaram à API ou que já foram removidas dela.

Para validar o fluxo conjunto sem usar uma conta WhatsApp, execute `tests/history-rescan-back.test.ts` com `QA_BACKEND_PATH` apontando para o backend. O teste usa um armazenamento isolado e o produtor/webhook reais com dados simulados; não necessita de PostgreSQL da API nem de sessão externa.
