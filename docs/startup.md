# Inicialização, reinício e porta ocupada

`EADDRINUSE: address already in use 127.0.0.1:15960` significa que o sistema operacional recusou o bind porque esse endereço já estava ocupado. Trocar a versão do Baileys ou apagar sessões não libera a porta. O processo pode ter sido iniciado por outro terminal, pelo painel da hospedagem, por PM2, Docker ou pelo modo de desenvolvimento.

Nesta API existe uma única abertura do servidor HTTP. `prisma generate` e `tsc` não iniciam a fila de webhooks. Portanto, mensagens de retry que aparecem durante `npm run build` indicam outro processo ativo/logs intercalados, ou código diferente do que foi publicado nesta pasta.

## Verificar no servidor com o erro

Execute na pasta da API:

```sh
npm run diagnose
```

O comando lê `HOST`/`PORT`, testa o bind exclusivo e libera imediatamente o socket quando a porta está livre. Mostra as chaves npm inválidas conhecidas, omitindo seus valores. Com a fila habilitada, verifica diretórios e permissões e conta arquivos pendentes, sem ler seu conteúdo. Não encerra processos, não cria diretórios, não abre banco/sessões e não processa webhooks. O resultado é uma fotografia daquele momento, não uma reserva da porta para uma inicialização futura. Código de saída 1 sinaliza porta indisponível ou falha de diagnóstico. Se a API estiver funcionando, a porta ocupada é esperada.

Para identificar o processo que usa **15960**, se essa é a porta atribuída pela hospedagem:

```sh
# Linux — leitura apenas; use o PID para identificar o serviço no painel.
ss -ltnp 'sport = :15960'
```

```powershell
# Windows — leitura apenas.
Get-NetTCPConnection -LocalPort 15960 -State Listen |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

Confira o serviço correspondente antes de encerrá-lo. Não use comandos que matem todos os processos Node ou apaguem a fila/sessões. O diagnóstico não substitui o reinício do processo existente.

## aaPanel — Node.js Project

No cenário informado, o cadastro mostrado no anexo é **ZapToBoxBackend**, com porta **15961** e entrada `dist/server.js`. O erro na **15960** pertence à API WhatsApp, cujo cadastro deve ser aberto separadamente.

| Projeto | Run opt | Porta no painel e no `.env` |
| --- | --- | --- |
| ZapToBoxAPI | Custom Command: `node dist/main.js`, ou `start [node dist/main.js]` | `15960` |
| ZapToBoxBackend | `start [node dist/server.js]` | `15961` |

O **Path** da API deve ser a pasta que contém seu `package.json`, `.env` e `dist/main.js`. Depois de enviar os arquivos atualizados, execute `npm run build` nessa pasta e use **Restart** em **Service status** no cadastro da API. Use o terminal com a versão de Node configurada para esse projeto. A seleção de pnpm no anexo não comprova a causa do conflito de porta; este repositório mantém `package-lock.json` para instalações com npm.

Se ambos os projetos estiverem no mesmo servidor, sem isolamento de rede por contêiner, esta configuração permite a comunicação local:

```dotenv
# .env da API WhatsApp
HOST=127.0.0.1
PORT=15960
WEBHOOK_URL=http://127.0.0.1:15961/api/webhooks/whatsapp
WEBHOOK_QUEUE=true
# WEBHOOK_SECRET deve ser idêntico ao do backend (mínimo de 32 caracteres).
```

```dotenv
# .env do backend
PORT=15961
WPP_API_URL=http://127.0.0.1:15960
# WPP_API_TOKEN deve ser igual ao JWT_TOKEN da API.
# WEBHOOK_SECRET deve ser igual ao WEBHOOK_SECRET da API.
```

O endereço público do webhook também pode ser `https://backend.zaptobox.pro/api/webhooks/whatsapp`, desde que o domínio encaminhe para o backend. Não use somente a raiz do domínio como `WEBHOOK_URL`.

Para a fila, `WEBHOOK_QUEUE_DIR` aceita caminho absoluto ou relativo ao **Path** do projeto; o padrão é `./webhook-queue`. Preserve o diretório já usado e seus eventos ao atualizar. O usuário selecionado em **User** precisa ler e gravar esse diretório, os arquivos existentes e `dead-letter`. Execute `npm run diagnose` com esse mesmo usuário: um diagnóstico feito como root não verifica as permissões de uma aplicação executada como www. Se escolher um caminho absoluto novo, copie os eventos existentes com a API parada e ajuste a propriedade para o usuário do processo antes de reiniciá-la.

O estado **Stopped** no painel não garante que outro processo não esteja usando a porta. Nesse caso, use o comando `ss` acima para identificar o PID e o serviço responsável e encerre/reinicie esse serviço no seu supervisor. Uma lista de PIDs pode incluir o gerenciador de pacotes e seu processo Node; a quantidade de PIDs, isoladamente, não comprova duplicidade.

### Outros painéis

Use uma única aplicação/processo para esta API. No painel, mantenha:

- **Compilação:** `npm run build`.
- **Inicialização:** `node dist/main.js` ou `npm start`, em primeiro plano.
- **Reinício:** a ação do painel que encerra a execução anterior antes de iniciar a nova.
- **Porta:** a porta atribuída à aplicação, mantendo `PORT` coerente no painel e no `.env`.

`npm run build:start` continua sendo um comando de terminal que compila e inicia em primeiro plano. Ele não procura nem reinicia outra execução. Executá-lo quando o painel já mantém a API ativa tentará abrir uma segunda instância. Não inicie um PM2 adicional dentro de uma aplicação já supervisionada pelo painel. Mantenha um prazo de encerramento de pelo menos 30 segundos para permitir a limpeza normal.

## PM2

Se **PM2 é o único supervisor**, use na pasta do projeto:

```sh
npm run build:pm2
```

Esse comando compila e usa `startOrRestart` com `ecosystem.config.json`, uma instância em modo `fork`, sem watch, nome `zaptobox-whatsapp-api` e 30 segundos para encerramento. Com o mesmo nome gerenciado pelo PM2, o comando inicia quando ausente ou reinicia a aplicação existente. Após compilar separadamente, `npm run restart:pm2` faz a mesma operação de início/reinício.

Se uma execução antiga foi cadastrada com outro nome, outro usuário/`PM2_HOME` ou fora do PM2, ela não será substituída por esse comando. Confira `pm2 list` e o processo da porta; remova a duplicidade no supervisor correto. A configuração não habilita cluster/réplicas sobre as mesmas sessões e fila. O PM2 precisa estar instalado no ambiente, como já exigiam os scripts anteriores.

## Mudanças na API

- A porta é reservada **antes** da conexão ao banco, da fila e da restauração de sessões.
- Conflito na porta informa endereço, PID da nova tentativa e orientação; não é tratado como inicialização bem-sucedida.
- Durante inicialização/encerramento, rotas de aplicação retornam 503. `/health` continua sendo liveness; `/health/ready` exige Bearer e verifica prontidão.
- Encerramento é idempotente, trata SIGINT/SIGTERM e a mensagem `shutdown` do PM2, drena as operações HTTP e tenta limpar todos os componentes mesmo se um deles falhar.
- Logs de startup incluem o PID para separar tentativas. Não há encerramento automático de processos alheios nem troca automática de porta.

## `Webhook retry failed`

O log antigo escondia erros de leitura/gravação da fila. Agora o diagnóstico de armazenamento inclui `component`, `phase`, `pid`, `code`, `directory` e orientação. Por exemplo, `EACCES` pede revisão do usuário/permissões do volume; `ENOTDIR` indica que um trecho do caminho é arquivo; `ENOSPC` indica falta de espaço. O diagnóstico não imprime URL do webhook, segredo, stack ou conteúdo das conversas.

O mesmo código consecutivo é registrado no máximo uma vez por minuto. Outro código aparece imediatamente, e as tentativas da fila continuam na frequência configurada. Isso evita inundar o log sem ocultar a falha persistente. `npm run diagnose` ajuda a verificar o caminho e o acesso; a correção de permissões, espaço ou caminho precisa ser feita no servidor conforme o código encontrado.

Uma falha HTTP/rede no destino continua usando o retry persistente normal. Não apague eventos para eliminar mensagens de erro. Mantenha um único processo usando `WEBHOOK_QUEUE_DIR`; veja [webhooks.md](webhooks.md).

## Avisos `--init.module` e `_-init.module` do npm

São avisos da configuração npm do ambiente, separados do erro de bind. O próprio npm lê essa configuração antes de executar qualquer script do projeto. A API não consegue removê-los alterando o seu `.env` nem ocultando logs.

`npm run diagnose` mostra arquivo/linha das chaves conhecidas, se acessíveis. Alternativamente, `npm config get globalconfig` e `npm config get userconfig` mostram os caminhos de configuração. Remova somente as entradas inválidas indicadas (`--init.module=...`, `_-init.module=...` ou a chave legada `init.module` quando sinalizada). Se a hospedagem injeta a configuração, corrija-a no painel/provedor. Reinicie a aplicação depois para descartar variáveis npm herdadas do processo antigo. Preserve registries e tokens do arquivo.

Não foi encontrada essa configuração inválida no ambiente local de desenvolvimento. A configuração que produziu o aviso precisa ser corrigida no servidor do log.

## Validação

Testes isolados cobrem porta efêmera ocupada, preservação do processo existente, ordem de inicialização, cleanup idempotente, parada durante conexão ao banco, falhas de cleanup, gate HTTP 503, entrada real `src/main.ts` com banco inacessível e porta ocupada, diagnóstico npm sem valores, `ENOTDIR` da fila e manutenção do retry HTTP. Nenhum WhatsApp ou banco de produção é iniciado nesses testes.

Fontes primárias: [aaPanel — Node.js Project](https://www.aapanel.com/docs/Function/Node.html), [Node.js — eventos e bind do servidor](https://nodejs.org/api/net.html#serverlisten), [PM2 — configuração e reinício](https://pm2.keymetrics.io/docs/usage/application-declaration/) e [npm — chaves desconhecidas no npmrc](https://github.com/npm/cli/blob/latest/docs/lib/content/configuring-npm/npmrc.md).
