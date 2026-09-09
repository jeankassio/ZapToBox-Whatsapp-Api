# Progresso do histórico

O evento `messaging-history.progress` informa o que esta API observou e colocou na fila de entrega. O backend do atendimento confirma seus próprios imports e downloads de mídia. Não existe uma porcentagem global garantida nem um evento que assegure que o WhatsApp nunca enviará mais histórico.

## Envelope e dados

O envelope HTTP continua `{id,timestamp,event,instance,data}`. `id` e `timestamp` persistem entre tentativas da fila. Para `messaging-history.progress`, `data` tem este formato:

```json
{
  "version": 1,
  "runId": "dcae54db-50ac-49d3-a94c-49f211dbd270",
  "startedAt": "2026-09-07T12:00:00.000Z",
  "resumed": false,
  "sequence": 3,
  "phase": "importing",
  "expectedChunks": 6,
  "expected": {"contacts": 101, "chats": 1, "messages": 201},
  "processedBatches": 0,
  "provider": {
    "syncType": 3,
    "progress": 100,
    "isLatest": true,
    "status": "complete",
    "explicit": true,
    "receivedPendingNotifications": true
  }
}
```

`runId` é um UUID novo por geração de socket, inclusive na reconexão. `startedAt` identifica seu início. `sequence` cresce a cada snapshot desse run; o consumidor ignora snapshots antigos e mantém a contabilidade dos runs anteriores. Os contadores são cumulativos dentro do run. `expected` conta entradas nas listas enviadas, não registros únicos no banco. Mensagens internas de distribuição de chaves/protocolo ficam fora dessa contagem; edição e revogação permanecem incluídas. `processedBatches` só aumenta quando um evento `messaging-history.set` inteiro foi persistido e enfileirado, inclusive quando seus arrays estão vazios.

`resumed` indica que as credenciais já tinham `accountSyncCounter` positivo ao criar o socket. Não inventa lotes e não prova que o backend recebeu o histórico anterior. Permite distinguir uma reconexão silenciosa de um primeiro pareamento: o receptor pode manter seu estado anterior confirmado, desde que todas as barreiras de entrega e mídia continuem satisfeitas; sem observação anterior, a situação permanece desconhecida.

| `phase` | Significado |
| --- | --- |
| `awaiting` | Socket ainda aguarda o primeiro histórico observado. |
| `receiving` | Há notificação de histórico, lote recém-planejado ou download observado ainda sem correspondência. |
| `importing` | API persiste o lote e enfileira seus chunks. |
| `waiting` | Lote conhecido persistido/enfileirado; aguarda possíveis lotes seguintes. Uma sessão retomada também pode começar aqui. |
| `paused` | Provedor sinalizou pausa; não equivale a conclusão. |
| `interrupted` | Socket encerrou, foi substituído ou desligado. |
| `error` | Processamento do histórico falhou; `error` contém `HISTORY_PROCESSING_FAILED`. |

Os campos de `provider` podem ser `null` quando não conhecidos. O percentual pode mudar de escala ou voltar a um valor menor quando `syncType` muda. Ele não mede o progresso do banco do atendimento, dos anexos, nem o total de todos os tipos de histórico.

## Chunks e confirmação no receptor

Antes de persistir ou emitir qualquer `.set`, a API planeja os arrays, soma exatamente seus chunks em `expectedChunks` e emite `receiving`. Em seguida emite `importing`, persiste e envia os lotes, e publica o estado resultante. Cada array tem até 100 entradas e 900.000 bytes, reservando margem para o envelope HTTP. Uma entrada individual grande demais provoca erro explícito e não produz um falso lote concluído.

As mensagens novas são inseridas em grupos de até 100, com uma consulta de existência e uma inserção por grupo. Repetições idênticas não provocam novas gravações; edições e atualizações parciais mantêm a mesclagem, a data original e os identificadores alternativos. Grupos com IDs repetidos ou uma primeira ocorrência já editada seguem o caminho sequencial para preservar a ordem de inserção usada no desempate de horários. Cada `messages.set` é enfileirado assim que sua fatia foi persistida, sem esperar o restante de um histórico grande. `processedBatches` continua contando apenas lotes inteiramente persistidos e enfileirados.

`contacts.set`, `chats.set` e `messages.set` preservam `data` como array e recebem este campo adicional no envelope:

```json
{
  "history": {
    "runId": "dcae54db-50ac-49d3-a94c-49f211dbd270",
    "startedAt": "2026-09-07T12:00:00.000Z",
    "batchId": "90b158d6-67b9-49dc-a7b5-55c3b81c2c60",
    "chunkId": "90b158d6-67b9-49dc-a7b5-55c3b81c2c60:messages.set:0"
  }
}
```

O receptor confirma cada chunk somente depois de persistir seu conteúdo e deduplica por instância, run e chunk. Reentregar o mesmo envelope não aumenta novamente os contadores. Uma alteração no conteúdo para o mesmo identificador deve ser tratada como conflito.

Com a fila durável, aguardar o envio significa aguardar sua gravação em disco; não significa que o HTTP já foi confirmado. Retries preservam ordenação por instância enquanto o item está pendente. Após esgotar tentativas, o item vai para dead-letter e os seguintes podem passar. Portanto, receber `waiting` exige comparar todos os chunks recebidos com os esperados, inclusive faltas em runs anteriores; ausência de mensagens novas não é prova de entrega. Reexecutar dead-letter mantém identificadores, permitindo completar essa contabilidade.

O backend pode exibir “Histórico recebido sincronizado” quando seus chunks conhecidos estão persistidos, a fila de mídias terminou e houve um intervalo sem novidades. Deve manter o aviso de que o WhatsApp pode enviar novos lotes. Essa frase limita-se ao histórico recebido. As contagens de anexos são responsabilidade do backend, porque esta API só entrega seus metadados/chaves e disponibiliza o download autenticado.

## Semântica do Baileys 7.0.0-rc14

`isLatest` é calculado pela ausência de histórico previamente registrado nas credenciais; corresponde ao primeiro histórico, e não ao último. O evento `.set` só aparece depois do download e processamento do payload. A biblioteca não fornece nesse fluxo um callback público de bytes transferidos. Fontes oficiais: [process-message.ts](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/src/Utils/process-message.ts) e [history.ts](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/src/Utils/history.ts).

`messaging-history.status` é emitido antes do processamento do histórico correspondente. `INITIAL_BOOTSTRAP` pode sinalizar `complete` sem verificar percentual; `RECENT` sinaliza `complete` ao receber 100 e `paused` após 120 segundos sem a conclusão explícita. Nenhum desses sinais confirma importação no receptor. `receivedPendingNotifications` se refere à fila de notificações offline. Fontes oficiais: [chats.ts](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/src/Socket/chats.ts), [socket.ts](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/src/Socket/socket.ts) e [tipos de eventos](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/src/Types/Events.ts).

A API observa notificações reais pelo hook `shouldSyncHistoryMessage`, ignorando sondagens que têm apenas `syncType`. O [buffer oficial](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/src/Utils/event-buffer.ts) pode reunir vários históricos, deduplicar entradas e manter apenas o marcador final. O tracker correlaciona esse marcador com um prefixo de notificações anteriores; notificações sem correspondência mantêm `receiving`. Essa correlação é uma inferência sobre lotes observáveis, não uma prova de que todo download interno teve sucesso ou de que acabaram todas as etapas. Falhas internas sem callback de erro identificável permanecem uma limitação do provedor.

Falhas de persistência, serialização e enqueue que esta API consegue observar geram erro redigido e param o socket. O encerramento normal drena os trabalhos aceitos e emite `interrupted`. Credenciais e dados privados não fazem parte do progresso.

## Reconexão e estado atual

Quedas transitórias retomam a sessão automaticamente com espera de 1, 2, 4, 8, 16 e, depois, 30 segundos entre tentativas. Não existe mais o encerramento das tentativas após a quinta falha. Logout, sessão inválida, substituição do dispositivo e demais motivos terminais continuam interrompendo a reconexão. Falhas de persistência ou da fila também continuam exigindo correção antes da retomada para evitar perda silenciosa de eventos.

O evento `connection.update` com `close` atualiza imediatamente o estado em memória e encerra o socket, mesmo enquanto um lote aceito termina sua gravação. Logout pelo celular passa diretamente para `REMOVED`; eventos `open` ou QR atrasados daquele socket não podem reativá-lo. O webhook `connection.close`/`connection.removed` é persistido diretamente no recebimento, fora da fila de importação. Gravações de histórico já aceitas continuam preservadas.

Eventos `connection.*` usam a subfila durável `WEBHOOK_QUEUE_DIR/lifecycle`, com processamento independente: histórico em andamento ou aguardando retry não impede a notificação de desconexão. Cada fila mantém a ordem por instância, identificadores estáveis, retries e dead-letter; estatísticas e replay incluem ambas. O receptor não deve pressupor ordem entre eventos de conexão e mensagens/contatos. Eventos antigos já gravados na raiz continuam disponíveis para entrega.

Os endpoints de estado, listagem e conexão conferem se o WebSocket está aberto antes de responder `ONLINE`. As instâncias expõem `connectionUpdatedAt`, horário da observação da mudança de estado, e `GET /instances/status/:owner/:instanceName` também retorna `observedAt`, horário da consulta, inclusive quando `exists: false`. Esses horários são ordenados dentro do processo e não devem substituir o controle de concorrência do receptor ou pressupor relógios sincronizados entre servidores. Um receptor deve confirmar o estado atual por esse endpoint quando processa um evento de conexão; não deve usar o `instance.connectionStatus` de uma mensagem ou contato antigo como prova de conexão atual.

O socket já envia verificações periódicas de conectividade. A presença pública permanece indisponível ao conectar (`markOnlineOnConnect: false`); essa configuração não desliga o transporte. O horário de atividade exibido pelo celular, isoladamente, não permite confirmar a causa de uma queda. A confirmação depende do estado atual e dos eventos de conexão da API.

## Validação

### Recuperação de anexos

O download reconhece os erros HTTP `404`/`410` em `output.statusCode`, formato efetivamente lançado pelo downloader da versão rc14, e pede uma única renovação do endereço ao dispositivo. Mensagens do histórico que contêm apenas `directPath` também são aceitas. A solicitação criptografada de renovação aguarda no máximo 15 segundos e sempre remove seus listeners ao terminar, expirar ou desconectar. A confirmação válida atualiza os metadados pelos eventos já persistidos da instância.

O endpoint autenticado `/media/download/:owner/:instanceName` distingue `404` (mensagem ausente nesta instância), `409` (conexão indisponível), `410` (anexo não recuperável), `504` (dispositivo não respondeu à renovação) e `502` (falha temporária do provedor). O consumidor deve pausar downloads de conexões offline e evitar gastar tentativas de mídia por uma desconexão. A renovação depende da disponibilidade do arquivo no WhatsApp/dispositivo; arquivos já indisponíveis não podem ser garantidos.

O webhook `messages.media-update` publica somente a chave da mensagem e, quando houver, um erro redigido. A API primeiro decifra e valida a confirmação: a presença de dados criptografados no evento bruto não indica sucesso e pode conter `NOT_FOUND`. Uma confirmação de renovação não deve invalidar a tentativa de download já em andamento no consumidor. Fotos de perfil têm prazo de consulta de 10 segundos; foto ausente ou restrita pelo contato retorna `data.status: null`.

### Desconectar para trocar o número

`POST /instances/disconnect/:owner/:instanceName` exige o mesmo escopo autenticado das demais operações da instância e não exige corpo. Solicita a remoção do dispositivo vinculado, drena as gravações, reseta as credenciais e retorna `instance.connectionStatus: "REMOVED"` com `instanceJid: null`. Mensagens, contatos e chats permanecem armazenados. O próximo `connect` permite novo pareamento.

Uma sessão registrada precisa estar online para confirmar o envio do logout (`409` enquanto offline). Falha no envio retorna `502` e preserva as credenciais. Repetir a operação enquanto já desvinculada não envia novo logout. Um integrador deve deduplicar a operação por uma chave persistente para impedir que uma repetição antiga desconecte um pareamento feito posteriormente. `DELETE /instances/delete/...` continua sendo a exclusão explícita dos dados e não deve ser usado para esta finalidade.

Os testes usam sockets, banco em memória e HTTP controlados. Cobrem sinais de 100/isLatest, pausa, ausência de metadados opcionais, downloads pendentes, chunks por bytes/quantidade, mensagens internas filtradas, importação bloqueada, falhas de banco/fila, reentrega de dead-letter e troca de geração. Nenhuma conta WhatsApp real é conectada durante essa verificação.
