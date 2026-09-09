# Recuperação de conexão — 09/09/2026

## O problema

O dispositivo pode continuar vinculado no celular enquanto a conexão de rede da API está interrompida. O painel precisa distinguir essas situações e acompanhar a recuperação do transporte, sem pedir um novo QR Code para uma sessão ainda válida.

A revisão identificou três causas locais:

- Falhas no processamento de mensagens, histórico ou persistência paravam a instância sem agendar recuperação.
- O tratamento de fechamento e a gravação de credenciais esperavam a fila de importação de histórico.
- Uma consulta de status podia alterar permanentemente o estado interno quando observava o socket momentaneamente fechado.

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

O backend mantém o número e os dados já importados durante a recuperação. Envio, importação e ressincronização dependem de transporte online. Pendências de importação do transporte fechado são canceladas; o marco temporal existente impede que entregas antigas continuem uma importação cancelada ou restabeleçam uma sessão removida.

## Política de recuperação

Quedas de transporte, reinício solicitado pelo protocolo e falhas recuperáveis de processamento preservam as credenciais. Há uma única tentativa por instância, com espera progressiva e variação aleatória, limitada a 30 segundos. Isso evita que várias conexões tentem voltar exatamente no mesmo instante.

O contador de tentativas só é zerado depois de 60 segundos de conexão estável. Abrir e falhar logo em seguida mantém a espera progressiva. A restauração das sessões na inicialização também repete falhas temporárias de descoberta ou carregamento, sem duplicar instâncias já restauradas.

Eventos e erros da geração anterior não podem encerrar a nova conexão. A gravação de credenciais e chaves recebe tratamento separado da fila de histórico, e uma nova conexão aguarda a conclusão dessas operações.

A revogação confirmada (`loggedOut`, código 401) encerra a recuperação e invalida as credenciais locais. Conflito com outra conexão (`connectionReplaced`, 440), acesso recusado (403) e incompatibilidade de dispositivo (411) preservam as credenciais, mas suspendem tentativas automáticas: repetir a mesma conexão nessas condições poderia disputar a sessão ou insistir numa recusa.

Um erro de sessão 500, isoladamente, não apaga as credenciais. Também não se apagam dados locais para simular que um logout remoto foi concluído. Se o usuário pedir para desconectar enquanto o transporte está indisponível, é necessário aguardar a recuperação para enviar o logout ou remover o dispositivo pelo celular.

Esta correção não impede quedas de rede nem revogações feitas pelo serviço remoto. Ela remove as causas locais identificadas de parada sem recuperação e mantém o painel alinhado ao estado conhecido.

## Publicação

1. Publique e compile o backend e reinicie seu serviço Node.js.
2. Publique os arquivos completos do frontend do usuário e a versão compilada do admin, incluindo os HTML com a versão nova dos módulos.
3. Publique e compile a API com `npm run build`; reinicie o processo que já a executa.

Não há nova migração de banco nesta alteração. Preserve o banco de autenticação, a pasta de sessões e a configuração de armazenamento existentes. O reinício permite restaurar sessões válidas que a versão anterior deixou paradas.

A mesma sessão deve ter apenas um processo proprietário. O arquivo PM2 do projeto usa uma instância em modo `fork`; ao reiniciar pelo aaPanel, use o gerenciador existente para não iniciar outro processo com as mesmas credenciais.

## Verificação

- API: regressões de fechamento, reconexão, histórico lento, erro de armazenamento, persistência de credenciais e logout.
- Backend: estados HTTP/webhook, eventos atrasados, permissões das ações e bloqueio de importação offline.
- Frontend e admin: apresentação de recuperação e disponibilidade das ações.
- Integração: `tests/connection-recovery-back.test.ts` exercita a API HTTP e o webhook reais com transporte simulado, autenticação em memória e SQLite isolado. Use `QA_BACKEND_PATH` apontando para o backend já compilado. Não conecta uma conta WhatsApp real.

## Referências consultadas

- [Exemplo oficial de conexão e reconexão](https://github.com/WhiskeySockets/Baileys/blob/master/Example/example.ts).
- [Documentação oficial de persistência e recuperação de sessão](https://github.com/WhiskeySockets/docs/blob/main/authentication/session-management.mdx).

A separação entre fechamento recuperável e logout e a persistência de credenciais seguem essas referências. A proteção contra concorrência, os limites de tentativas por instância e a apresentação no painel são decisões do ZapToBox.
