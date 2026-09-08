# API HTTP

Contrato das rotas implementadas em `src/app.ts` e `src/infra/http/routes`. URL local: `http://localhost:3001`. Uma operação WhatsApp exige sessão realmente pareada.

## Autenticação, escopo e respostas

Somente `GET /health` é público. As outras rotas exigem `Authorization: Bearer TOKEN`. O valor estático de `JWT_TOKEN` autentica um administrador. Também são aceitos JWTs HS256 assinados com esse segredo, contendo `owner` como string e, opcionalmente, `instanceName`; esses tokens só acessam o escopo indicado. Não há endpoint para emitir tokens. Claims `exp`/`nbf`, quando presentes, são verificadas.

`owner` e `instanceName` identificam a sessão. Na integração com `ZapToBox novo - Back`, **owner é o ID interno da conexão**, não o usuário final. Codifique os componentes na URL. Cada componente aceita 1–100 caracteres sem separadores de caminho, controles, espaços nas extremidades ou nomes reservados de arquivo do Windows.

Corpos usam `Content-Type: application/json`. Sucesso usual: `200 {success:true,message?,data?}`. Falhas de rota/controller: `{success:false,error:string}`. Autenticação inválida: `401 {error:"Invalid Token"}`. Administração pode responder `403 {error:"Administrator token required"}`. Esta API não utiliza o envelope obrigatório `{data:...}` do backend de atendimento.

| HTTP | Significado |
| --- | --- |
| 400 | JSON, identidade, JID ou parâmetros inválidos; formato de mídia inadequado. |
| 401 | Bearer ausente ou inválido. |
| 403 | Escopo insuficiente ou ação proibida. |
| 404 | Mensagem/contato/rota ausente no escopo. |
| 409 | Socket desconectado ou operação incompatível com o estado atual. |
| 413 | Corpo ou mídia acima do limite. |
| 500 | Erro interno sem detalhes privados. |
| 502 | WhatsApp ou download não concluiu a operação. |
| 503 | Readiness indisponível. |

JIDs aceitos incluem telefone `@s.whatsapp.net`, LID `@lid`, grupo `@g.us`, `status@broadcast` e canal `@newsletter`. Números com 5–15 dígitos e `+` opcional são convertidos para `@s.whatsapp.net`; nem toda operação aceita todos esses destinatários. IDs de mensagem têm até 255 caracteres sem controles. Booleanos são JSON `true`/`false`, não strings.

## Saúde e fila

| Método e caminho | Entrada | Resposta |
| --- | --- | --- |
| `GET /health` | Público. | `{status:"ok",version:"1.3.0",baileys:"7.0.0-rc14"}`; processo HTTP vivo. |
| `GET /health/ready` | Bearer. | `{status:"ready"}` ou `503 {status:"unavailable"}`; verifica inicialização/banco, não garante WhatsApp online. |
| `GET /webhooks/queue` | Administrador. | `{success:true,pending:number,deadLetter:number}`. |
| `POST /webhooks/queue/replay` | Administrador; sem corpo obrigatório. | `{success:true,replayed:number}`. |

## Instâncias

| Método e caminho | Entrada | Resposta |
| --- | --- | --- |
| `POST /instances/create` | Cabeçalho obrigatório `Idempotency-Key: UUID v4`; `{owner:string|number,instanceName:string,phoneNumber?:string}`. Número com país e 7–15 dígitos, sem `+`. | `{success:true,instance,qrCode?,pairingCode?}`. Repetir a mesma identidade retorna `idempotent:true` sem abrir outro socket. |
| `GET /instances/status/:owner/:instanceName` | Sem corpo; exige escopo exato ou administrador. | `{success:true,exists:boolean,data:InstanceInfo|null}`. Consulta cache, credencial persistida e sessão em disco. |
| `GET /instances/get` | Query opcional `owner`. Token restrito só recebe suas sessões. | `{success:true,data:InstanceInfo[]}`. |
| `GET /instances/connect/:owner/:instanceName` | Sem corpo. | `{success:true,instance,qrCode?,pairingCode?}`. |
| `POST /instances/connect/:owner/:instanceName` | Alias do GET. | Mesmo resultado. |
| `DELETE /instances/delete/:owner/:instanceName` | Sem corpo. | `{success:true,message}`. Remove credenciais e dados locais da instância, além de encerrar o socket. |

`InstanceInfo`: `owner`, `instanceName`, `connectionStatus` (`ONLINE`, `OFFLINE`, `REMOVED`), `profilePictureUrl?` e `instanceJid?`. `qrCode` é uma data URL PNG. Sucesso HTTP na criação significa inicialização aceita: aguarde `connection.open` para enviar. QR pode chegar posteriormente pelo webhook. A identidade `owner/instanceName` é a chave idempotente durável; o UUID protege o pedido HTTP e deve ser reutilizado pelo chamador ao reconciliar a mesma operação.

## Mensagens

Todos os envios usam `{remoteJid,message,delay?,options?}`; `jid` é alias de `remoteJid`. `delay` aceita 0–30000 milissegundos ou `"auto"`, que simula digitação com teto de 30 segundos. `options.quoted` é o **ID** de mensagem guardada na mesma instância e conversa; outras opções não são encaminhadas arbitrariamente ao socket.

Texto também aceita `{remoteJid,text,mentions?}` diretamente. Se `message` estiver presente, seu conteúdo tem precedência sobre `text`/`mentions` da raiz.

| Método e caminho | Conteúdo de `message` |
| --- | --- |
| `POST /messages/sendText/:owner/:instanceName` | `{text:string,mentions?:Jid[]}`; texto não vazio até 65.536 caracteres; até 1024 menções. |
| `POST /messages/sendLocation/:owner/:instanceName` | `{location:{degreesLatitude:number,degreesLongitude:number,name?:string,address?:string}}`, intervalos ±90 e ±180; nome até 255 caracteres, endereço até 1024. |
| `POST /messages/sendContact/:owner/:instanceName` | `{displayName:string,waid:number,phoneNumber:string}`; waid inteiro positivo, nome até 120, telefone até 30 caracteres. |
| `POST /messages/sendReaction/:owner/:instanceName` | `{emoji:string,messageId:string}`; emoji até 32 caracteres, vazio remove reação. |
| `POST /messages/sendPoll/:owner/:instanceName` | `{poll:{name:string,values:string[],selectableCount:number,toAnnouncementGroup?:boolean}}`; nome até 255, 2–12 opções distintas até 100, seleção entre 1 e quantidade de opções. |
| `POST /messages/sendImage/:owner/:instanceName` | `{image:{url:string},caption?:string,viewOnce?:boolean}`. |
| `POST /messages/sendVideo/:owner/:instanceName` | `{video:{url:string},caption?:string,viewOnce?:boolean,ptv?:boolean}`. |
| `POST /messages/sendGif/:owner/:instanceName` | `{video:{url:string},gifPlayback:true,caption?:string,viewOnce?:boolean,ptv?:boolean}`; use vídeo MP4, pois o WhatsApp não recebe `.gif` diretamente; não converte o arquivo. |
| `POST /messages/sendAudio/:owner/:instanceName` | `{audio:{url:string},mimetype:string,ptt?:boolean,viewOnce?:boolean}`. |
| `POST /messages/sendDocument/:owner/:instanceName` | `{document:{url:string},mimetype:string,fileName:string}`; nome até 255 sem controles. |
| `POST /messages/sendSticker/:owner/:instanceName` | `{sticker:{url:string},isAnimated?:boolean}`; arquivo WebP já preparado para o WhatsApp; `isAnimated:true` para figurinha animada. |
| `POST /messages/sendForward/:owner/:instanceName` | `{forward:string}`; ID de mensagem da mesma instância, podendo vir de outra conversa. |
| `POST /messages/sendPin/:owner/:instanceName` | `{pin:{key:{id:string},type:1\|2,time:86400\|604800\|2592000}}`; 1 fixa, 2 desafixa; chave real consultada na mesma conversa. |

Resposta: `{success:true,message,messageId,key,data:WAMessage,syncPending?:true}`. O ID vem do WhatsApp. `syncPending:true` indica envio aceito com falha posterior na gravação/publicação local; **não repita automaticamente**. Não há chave HTTP de idempotência para envio. Um timeout também pode acontecer depois de o WhatsApp aceitar a mensagem.

URLs de mídia usam HTTP/HTTPS público sem credenciais, até 4096 caracteres. Download valida DNS e cada redirecionamento, bloqueia redes privadas e limita a 50 MiB, até três redirecionamentos e 20 segundos por tentativa. Origens exatas configuradas pelo operador em `TRUSTED_MEDIA_ORIGINS` também podem servir anexos em redes privadas; essa permissão é reavaliada a cada redirecionamento. Não há multipart, leitura arbitrária de arquivos ou transcodificação. `mimetype` tem até 128 caracteres e caption até 65.536.

Links enviados ou editados em mensagens de texto podem incluir título, descrição e miniatura, preparados pela própria API. O primeiro link HTTP/HTTPS, `www` ou domínio reconhecido é consultado em HTTP na porta 80 ou HTTPS na porta 443. A API analisa somente o HTML baixado, usa a imagem indicada em Open Graph, Twitter Cards ou `image_src` e fornece um JPEG pronto ao cliente WhatsApp; a busca automática de miniaturas do provedor permanece desativada.

As prévias só acessam endereços públicos, com DNS fixado na conexão e cada redirecionamento revalidado. `TRUSTED_MEDIA_ORIGINS` **não** autoriza destinos privados para prévias. O prazo total é de até 6 segundos, incluindo espera na fila, DNS, downloads e processamento; há no máximo quatro trabalhos ativos e 32 pendências. HTML e imagens têm limites de 512 KiB e 5 MiB, inclusive após descompressão. JPEG, PNG, WebP e GIF são processados em worker separado, com limites de dimensões/pixels; o resultado é um JPEG de até 320 pixels no maior lado e 64 KiB. Uma URL direta de imagem também pode gerar prévia quando couber no limite inicial de 512 KiB.

O cache é separado por conexão e URL, por até 15 minutos, limitado a 32 entradas por conexão e 256 no processo; buscas simultâneas da mesma conexão/URL compartilham trabalho. Falhas são guardadas por 30 segundos. Se o site não fornecer imagem compatível, bloquear acesso, demorar ou exceder os limites, o texto é enviado normalmente, sem repetir o envio nem consultar a miniatura pelo downloader automático. Remover ou substituir o link em uma edição recalcula a prévia correspondente.

Figurinhas e GIFs recebidos mantêm `stickerMessage.isAnimated` e `videoMessage.gifPlayback` nos webhooks, junto dos campos de download. Localizações mantêm coordenadas, `name` e `address` em `locationMessage`; localizações em tempo real recebidas ficam em `liveLocationMessage`. Enviar uma localização por esta API envia um ponto estático. O cliente deve pesquisar o endereço e fornecer as coordenadas; esta API não faz geocodificação. Os contratos seguem os [tipos oficiais do Baileys](https://github.com/WhiskeySockets/Baileys/blob/master/src/Types/Message.ts) e o [envio oficial de GIFs](https://github.com/WhiskeySockets/Baileys/blob/master/README.md#gif-message).

| Método e caminho | Corpo JSON | Comportamento |
| --- | --- | --- |
| `PATCH /messages/editMessage/:owner/:instanceName` | `{remoteJid,messageId,text}`; `jid` como alias. | Edita somente mensagem própria. Retorna resultado de envio acima. |
| `PATCH /messages/readMessage/:owner/:instanceName` | `{remoteJid,messageId}`. | Envia confirmação de leitura. |
| `DELETE /messages/deleteMessage/:owner/:instanceName` | `{remoteJid,messageId,forEveryone:boolean}`. | Exclui para todos ou para a conta, conforme permissão do WhatsApp. |
| `PATCH /messages/unstar/:owner/:instanceName` | `{remoteJid,messageId,star:boolean}`. | Define ou remove estrela; nome de rota legado. |

As três últimas ações retornam `{success:true,message}`. IDs para reação, edição, leitura, exclusão, estrela e fixação são validados por instância e conversa. O WhatsApp pode rejeitar ações por prazo, permissão ou estado.

## Download de mídia

`POST /media/download/:owner/:instanceName` aceita `{messageId,isBase64?:boolean}` e exige imagem, vídeo, áudio, documento ou sticker da instância. O socket pode pedir reupload. Limite: 50 MiB.

- `isBase64:false` (padrão): bytes com Content-Type validado sintaticamente, Content-Disposition attachment e nosniff.
- `isBase64:true`: `{success:true,base64:"data:TIPO;base64,..."}`.

## Conversas

| Método e caminho | Corpo JSON |
| --- | --- |
| `PATCH /chat/rejectCall/:owner/:instanceName` | `{callId,callFrom:Jid}`. |
| `POST /chat/sendPresence/:owner/:instanceName` | `{presence,remoteJid?:Jid}`; presence: available, unavailable, composing, recording, paused. |
| `PATCH /chat/archiveChat/:owner/:instanceName` | `{remoteJid,archive:boolean}`. |
| `PATCH /chat/mute/:owner/:instanceName` | `{remoteJid,mute:number}`; 0 remove silêncio, 1 usa 24h, 2 usa 7 dias. |
| `PATCH /chat/markChatAsRead/:owner/:instanceName` | `{remoteJid,markAsRead:boolean}`. |
| `DELETE /chat/deleteChat/:owner/:instanceName` | `{remoteJid}`. |
| `PATCH /chat/unpin/:owner/:instanceName` | `{remoteJid,pin:boolean}`; permite fixar e desafixar. |

Retornam `{success:true,message}`. Arquivar, marcar lida e excluir precisam da última mensagem armazenada na mesma conversa; sem histórico retornam 404. Essas ações operam no WhatsApp. Preferências locais do frontend têm endpoints próprios no backend de atendimento.

## Grupos

`groupJid` termina em `@g.us`. `participants` contém 1–1024 JIDs, removendo duplicatas. A conta precisa das permissões de grupo adequadas. Todos retornam `{success:true,message,data?}`.

| Método e caminho | Corpo JSON | `data` no sucesso |
| --- | --- | --- |
| `POST /group/create/:owner/:instanceName` | `{groupName,participants}`; nome até 100. | GroupMetadata retornado por groupCreate. |
| `PATCH /group/participantsUpdate/:owner/:instanceName` | `{groupJid,participants,method}`; add, remove, demote, promote. | Resultado por participante. |
| `PATCH /group/subject/:owner/:instanceName` | `{groupJid,subject}`; até 100. | Ausente. |
| `PATCH /group/description/:owner/:instanceName` | `{groupJid,description}`; até 2048, vazio permitido. | Ausente. |
| `PATCH /group/setting/:owner/:instanceName` | `{groupJid,setting}`; announcement, not_announcement, locked, unlocked. | Ausente. |
| `POST /group/leave/:owner/:instanceName` | `{groupJid}`. | Ausente. |
| `POST /group/getInviteCode/:owner/:instanceName` | `{groupJid}`. | `{code,link}`. |
| `POST /group/revokeInviteCode/:owner/:instanceName` | `{groupJid}`. | `{code,link}` novo. |
| `POST /group/join/:owner/:instanceName` | `{code}`; código ou URL https://chat.whatsapp.com/.... | `{response}` com aceite. |
| `POST /group/joinByInviteMessage/:owner/:instanceName` | `{groupJid,messageId}`. | `{response}`; confere convite guardado na instância e seu grupo. |
| `POST /group/infoByCode/:owner/:instanceName` | `{code}`. | `{response:GroupMetadata}`. |
| `POST /group/metadata/:owner/:instanceName` | `{groupJid}`. | `{response:GroupMetadata}`. |
| `POST /group/participantsList/:owner/:instanceName` | `{groupJid}`. | `{response}` com pedidos pendentes, não membros atuais. |
| `GET /group/allParticipantsGroups/:owner/:instanceName` | Sem corpo. | `{response}` com mapa dos grupos da conta. |
| `PATCH /group/requestParticipants/:owner/:instanceName` | `{groupJid,participants,action}`; approve ou reject. | `{response}` com resultado. |
| `PATCH /group/expirationMessage/:owner/:instanceName` | `{groupJid,time}`; 0, 86400, 604800, 7776000 ou strings "0", "24h", "7d", "90d". | Ausente. |
| `PATCH /group/addMode/:owner/:instanceName` | `{groupJid,onlyAdmin:boolean}`. | Ausente. |
| `PATCH /group/joinApproval/:owner/:instanceName` | `{groupJid,enabled:boolean}`. | Ausente. |
| `POST /group/revokeInviteMessage/:owner/:instanceName` | `{groupJid,invitedJid}`. | `{response}` quando retornado. |

GroupMetadata e resultados por participante mantêm o formato Baileys; este serviço não os converte em DTOs da interface.

## Perfil

| Método e caminho | Corpo JSON | `data` no sucesso |
| --- | --- | --- |
| `POST /profile/onWhatsapp/:owner/:instanceName` | `{id:Jid}`; remoteJid como alias. | Contato persistido `{id?,name?,lid?,phoneNumber?}` ou `{id}` de consulta. |
| `POST /profile/fetchStatus/:owner/:instanceName` | `{remoteJid}`. | `{status}`. |
| `POST /profile/fetchProfilePicture/:owner/:instanceName` | `{remoteJid}`. | `{status:URL\|null}`. |
| `POST /profile/fetchBusinessProfile/:owner/:instanceName` | `{remoteJid}`. | `{profile}`. |
| `POST /profile/presenceSubscribe/:owner/:instanceName` | `{remoteJid}`. | Ausente. |
| `PATCH /profile/profileName/:owner/:instanceName` | `{name}`; não vazio, até 25. | Ausente. |
| `PATCH /profile/profileStatus/:owner/:instanceName` | `{status}`; até 139, vazio permitido. | Ausente. |
| `PUT /profile/profilePicture/:owner/:instanceName` | `{jid,url?:string\|null}`; remoteJid como alias. URL ausente/nula/vazia remove foto. | Ausente. |

Retornam `{success:true,message,data?}`. Alteração de foto usa as verificações de URL pública dos downloads de mensagens.

## Privacidade

`privacy` geral aceita all, contacts, contact_blacklist, none. Exceções abaixo. Retornam `{success:true,message,data?}`.

| Método e caminho | Corpo JSON | `data` no sucesso |
| --- | --- | --- |
| `PATCH /privacy/unblock/:owner/:instanceName` | `{remoteJid,block:boolean}`; true bloqueia, false desbloqueia. | Ausente. |
| `GET /privacy/privacySettings/:owner/:instanceName` | Sem corpo. | `{privacy}` com configurações. |
| `GET /privacy/blockList/:owner/:instanceName` | Sem corpo. | `{privacy:Jid[]}`. |
| `PATCH /privacy/lastSeen/:owner/:instanceName` | `{privacy}` geral. | Ausente. |
| `PATCH /privacy/online/:owner/:instanceName` | `{privacy}` all ou match_last_seen. | Ausente. |
| `PATCH /privacy/picture/:owner/:instanceName` | `{privacy}` geral. | Ausente. |
| `PATCH /privacy/status/:owner/:instanceName` | `{privacy}` geral. | Ausente. |
| `PATCH /privacy/read/:owner/:instanceName` | `{privacy}` all ou none. | Ausente. |
| `PATCH /privacy/addGroups/:owner/:instanceName` | `{privacy}` all, contacts ou contact_blacklist. | Ausente. |
| `PATCH /privacy/expirationMessage/:owner/:instanceName` | `{ephemeral}`; mesmos valores de time na expiração de grupos. | Ausente. |
| `PATCH /privacy/calls/:owner/:instanceName` | `{privacy}` all ou known. | Ausente. |
| `PATCH /privacy/messages/:owner/:instanceName` | `{privacy}` all ou contacts. | Ausente. |
| `PATCH /privacy/linkPreviews/:owner/:instanceName` | `{disabled:boolean}`. | Ausente. |

## Integração de atendimento

O frontend acessa `ZapToBox novo - Back` com cookie/CSRF. Esta API usa Bearer entre servidores. O backend utiliza criação, reconexão, envio de texto, perfil e download, além dos [webhooks](webhooks.md). Outras rotas documentadas estão disponíveis para clientes autenticados; sua existência não implica tela correspondente no frontend.
