# Recuperação de conexão — atualizado em 10/09/2026

## O problema

O dispositivo pode continuar vinculado no celular enquanto a conexão de rede da API está interrompida. O painel precisa distinguir essas situações e acompanhar a recuperação do transporte, sem pedir um novo QR Code para uma sessão ainda válida.

A revisão identificou três causas locais:

- Falhas no processamento de mensagens, histórico ou persistência paravam a instância sem agendar recuperação.
- O tratamento de fechamento e a gravação de credenciais esperavam a fila de importação de histórico.
- Uma consulta de status podia alterar permanentemente o estado interno quando observava o socket momentaneamente fechado.

A revisão de 10/09 identificou e corrigiu outros caminhos reproduzíveis:

- Os códigos 440, 403 e 411 deixavam a instância parada indefinidamente, mesmo preservando as credenciais. Agora mantêm recuperação automática com intervalo maior.
- Um transporte fechado sem `connection.update` ou uma autenticação que não chegava a `open` podiam ficar presos até intervenção manual. Uma supervisão compartilhada verifica as instâncias a cada 15 segundos; autenticações de sessões já registradas têm prazo de 120 segundos. Conexões saudáveis sem mensagens continuam abertas, usando o keepalive do Baileys.
- Falhas temporárias ao gravar chaves Signal descartavam as operações pendentes. Os valores e exclusões agora ficam pendentes até confirmação do armazenamento; uma falha de chaves fecha o transporte e impede sua reabertura antes dessa confirmação.
- No encerramento do serviço, a falha de uma sessão podia liberar o fechamento do banco enquanto outras ainda gravavam dados. Todas as sessões agora são aguardadas antes de propagar os erros.

## Contrato entre API e backend

O campo legado `instance.connectionStatus` continua usando `ONLINE`, `OFFLINE` e `REMOVED`. O campo adicional `instance.connectionState` descreve o ciclo da sessão:

| API | Estado adicional | Painel |
| --- | --- | --- |
| `ONLINE` | `connected` | Conectado |
| `OFFLINE` | `reconnecting` | Reconectando |
| `OFFLINE` | `pairing` | Conectando / aguardando pareamento |
| `OFFLINE` | `disconnected` | Desconectado; sem recuperação automática ativa |
| `REMOVED` | `disconnected` | Desconectado; sessão revogada |

Esses campos são retornados na consulta HTTP e nos webhooks. A leitura de status não altera a instância. `connectionUpdatedAt` identifica a transição; consultar o estado não inventa uma nova transição.

O backend mantém o número e os dados já importados durante a recuperação. Envio, importação e ressincronização dependem de transporte online. Os runs antigos de histórico são interrompidos; o marco temporal existente impede que entregas antigas continuem uma importação cancelada ou restabeleçam uma sessão removida. Downloads de mídia já aceitos permanecem na fila durante `reconnecting` e retomam com o transporte online. Logout confirmado mantém o cancelamento dessas pendências.

## Política de recuperação

Quedas de transporte, reinício solicitado pelo protocolo e falhas recuperáveis de processamento preservam as credenciais. Há uma única tentativa por instância, com espera progressiva e variação aleatória, limitada a 30 segundos. Isso evita que várias conexões tentem voltar exatamente no mesmo instante.

O contador de tentativas só é zerado depois de 60 segundos de conexão estável. Abrir e falhar logo em seguida mantém a espera progressiva. A restauração das sessões na inicialização também repete falhas temporárias de descoberta ou carregamento, sem duplicar instâncias já restauradas.

Eventos e erros da geração anterior não podem encerrar a nova conexão. A gravação de credenciais e chaves recebe tratamento separado da fila de histórico, e uma nova conexão aguarda a conclusão dessas operações.

A revogação confirmada (`loggedOut`, código 401) encerra a recuperação e invalida as credenciais locais. Conflito com outra conexão (`connectionReplaced`, 440) preserva as credenciais e agenda outra tentativa em 60–75 segundos. Acesso recusado (403) e incompatibilidade de dispositivo (411) aguardam 5–6,25 minutos. O intervalo maior evita tentativas rápidas repetidas; uma recusa persistente ainda exige investigar o provedor e a configuração. Cliques/polling do painel respeitam a tentativa já agendada e não criam sockets concorrentes.

Ao ocorrer logout confirmado, chaves pendentes da sessão antiga são descartadas somente junto da gravação bem-sucedida de novas credenciais vazias. Não são reaplicadas à sessão seguinte. Durante indisponibilidade de armazenamento, valores pendentes ficam em memória: encerrar à força o processo antes de o armazenamento voltar ainda pode perder esses valores. Banco e volumes persistentes disponíveis continuam sendo necessários.

Um erro de sessão 500, isoladamente, não apaga as credenciais. Também não se apagam dados locais para simular que um logout remoto foi concluído. Se o usuário pedir para desconectar enquanto o transporte está indisponível, é necessário aguardar a recuperação para enviar o logout ou remover o dispositivo pelo celular.

Esta correção não impede quedas de rede nem revogações feitas pelo serviço remoto. Ela remove as causas locais identificadas de parada sem recuperação e mantém o painel alinhado ao estado conhecido.

## Publicação

1. Publique e compile o backend e reinicie seu serviço Node.js.
2. Publique os arquivos completos do frontend do usuário e a versão compilada do admin, incluindo os HTML com a versão nova dos módulos.
3. Publique e compile a API com `npm run build`; reinicie o processo que já a executa.

Não há nova migração de banco nesta alteração. Preserve o banco de autenticação, a pasta de sessões e a configuração de armazenamento existentes. O reinício permite restaurar sessões válidas que a versão anterior deixou paradas.

A mesma sessão deve ter apenas um processo proprietário. O arquivo PM2 do projeto usa uma instância em modo `fork`; ao reiniciar pelo aaPanel, use o gerenciador existente para não iniciar outro processo com as mesmas credenciais. A recuperação de 440 não substitui coordenação entre hosts: duas réplicas usando a mesma sessão podem disputar a conexão. Esta alteração não habilita esse modo de implantação.

## Verificação

- API: regressões de fechamento, reconexão, histórico lento, erro de armazenamento, persistência de credenciais e logout.
- Backend: estados HTTP/webhook, eventos atrasados, permissões das ações e bloqueio de importação offline.
- Frontend e admin: apresentação de recuperação e disponibilidade das ações.
- Integração: `tests/connection-recovery-back.test.ts` exercita a API HTTP e o webhook reais com transporte simulado, autenticação em memória e SQLite isolado. Use `QA_BACKEND_PATH` apontando para o backend já compilado. Não conecta uma conta WhatsApp real.

## Referências consultadas

- [Exemplo oficial de conexão e reconexão](https://github.com/WhiskeySockets/Baileys/blob/master/Example/example.ts).
- [Documentação oficial de persistência e recuperação de sessão](https://github.com/WhiskeySockets/docs/blob/main/authentication/session-management.mdx).

A separação entre fechamento recuperável e logout e a persistência de credenciais seguem essas referências. A proteção contra concorrência, os limites de tentativas por instância e a apresentação no painel são decisões do ZapToBox.
