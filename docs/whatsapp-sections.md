# Catálogo de canais e comunidades

`GET /instances/sections/:owner/:instanceName` usa a mesma autenticação e escopo das demais rotas. Não conecta uma sessão, segue canais, entra em grupos ou marca publicações como lidas. O envelope é `{ success: true, data: ... }`:

```json
{
  "channels": [{"jid": "120363123456789@newsletter", "name": "Nome recebido", "description": "", "readOnly": true}],
  "communities": [{"jid": "120363123456780@g.us", "name": "Comunidade", "description": "", "readOnly": true,
    "groups": [{"jid": "120363123456781@g.us", "name": "Avisos", "linkedParent": "120363123456780@g.us", "isCommunityAnnounce": true, "readOnly": true}]}],
  "groups": [{"jid": "120363123456782@g.us", "name": "Grupo desvinculado", "description": "", "isCommunity": false, "linkedParent": null, "isCommunityAnnounce": false, "announce": false, "readOnly": false}],
  "observedAt": "2026-09-10T12:00:00.000Z",
  "available": true,
  "partial": false,
  "limitations": ["NEWSLETTER_OBSERVED_ONLY", "STATUS_RECEIVED_ONLY"]
}
```

Os valores acima ilustram o contrato; a rota retorna apenas JIDs observados no armazenamento ou informados pelo WhatsApp. Metadados de comunidades são consultados por `groupFetchAllParticipating` e `communityFetchAllParticipating`; os campos `isCommunity`, `isCommunityAnnounce` e `linkedParent` também são preservados em `Chat.data` quando chegam eventos `groups.upsert` e `groups.update`. Grupos comuns sem vínculo não entram no catálogo de comunidades. Listas de participantes, chaves de mídia e tokens não são retornados pelo catálogo.

O campo adicional `groups` transporta metadados de até 1.000 grupos observados, incluindo aqueles que saíram de uma comunidade. Em respostas completas por grupo, `linkedParent: null` desfaz o vínculo, `isCommunity: false` desfaz a classificação e `description: ""` remove a descrição anterior. Eventos parciais preservam campos omitidos. O consumidor deve aplicar esses registros após a árvore `communities` e nunca inferir remoção pela ausência de um grupo em uma resposta parcial. Falhas de consulta conservam as observações anteriores. Eventos de metadados invalidam o cache imediatamente; patches recebidos durante uma consulta prevalecem sobre seu snapshot, inclusive quando a fila de importação ainda está ocupada.

Canais são descobertos nos chats e nas mensagens realmente recebidas. O Baileys **7.0.0-rc14 instalado** não oferece método para enumerar todos os canais seguidos; por isso `NEWSLETTER_OBSERVED_ONLY` é permanente. A rota consulta `newsletterMetadata('jid', jid)` para até 20 canais conhecidos, no máximo quatro consultas simultâneas, com prazo de dois segundos por consulta. O resultado é reutilizado por 60 segundos por socket e instância. O catálogo tem limite de 1.000 registros e indica `partial` quando limitado ou incompleto. Isso não promete recuperação de publicações anteriores: `newsletterFetchMessages` dessa versão retorna nós do protocolo e não é tratado como um histórico completo.

Com a sessão offline, os registros persistidos continuam disponíveis com `available: false` e `CONNECTION_UNAVAILABLE`. Falhas parciais preservam o que já foi observado e acrescentam `COMMUNITY_METADATA_UNAVAILABLE`, `CHANNEL_METADATA_UNAVAILABLE`, `CHANNEL_METADATA_BATCH_LIMIT` ou `PARTIAL_CATALOG`. O frontend deve diferenciar ausência de dados recebidos de falha de consulta. `observedAt` identifica a geração do snapshot retornado; com `available: false` ele não confirma consulta recente ao WhatsApp.

Status continuam sendo recebidos em `messages.upsert`/histórico com `key.remoteJid = 'status@broadcast'`, autoria em `key.participant` e o timestamp original. A API não inventa uma lista remota de status que o dispositivo vinculado não recebeu. O consumidor deve separá-los dos atendimentos e expirá-los em 24 horas. Para mídia, `POST /media/download/:owner/:instanceName` aceita `{ "messageId": "...", "remoteJid": "status@broadcast" }`: o JID deve corresponder exatamente ao registro; status expirados retornam HTTP 410 antes do download. Permanecem os limites existentes de tempo, tamanho e concorrência da mídia.

Referências primárias: implementação oficial de [newsletters](https://github.com/WhiskeySockets/Baileys/blob/master/src/Socket/newsletter.ts) e de [comunidades](https://github.com/WhiskeySockets/Baileys/blob/master/src/Socket/communities.ts). O contrato implementado foi conferido também no código e nas declarações da versão instalada, que prevalecem sobre alterações posteriores do branch principal.
