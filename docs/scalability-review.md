# Revisão de escalabilidade e estabilidade — 09/09/2026

Alvo informado: cerca de 1.000 números WhatsApp conectados e 1.000 painéis abertos; servidor atual com 8 CPUs e 16 GB, expansão gradual. A divisão dessa máquina entre API, backend e bancos não foi informada. Esta revisão não certifica 1.000 sessões reais nesse hardware. Os testes são locais e sintéticos, sem login, mensagens ou carga em produção.

## Correções entregues

| Caminho | Problema confirmado | Alteração e limite |
|---|---|---|
| Fila de webhooks | Todos os corpos pendentes eram mantidos em memória antes da entrega; um histórico grande ocupava um worker até terminar | Planejamento guarda apenas metadados pequenos; corpo é lido somente ao entregar. Cada instância cede a vez após 16 eventos. Ordem por instância e identidade de retry preservadas |
| Estado de conexão | Histórico lento bloqueava a notificação de logout | `connection.*` tem fila durável própria; confirmação de logout não espera a importação |
| Caches de socket | TTL sem varredura e sem máximo conservava chaves nunca consultadas novamente | Cache TTL/LRU sem timers: retry 2.048 entradas, dispositivos 1.024, grupos 128, Signal 4.096 por socket. Evicção de Signal remove só cópia derivada; persistência permanece no banco |
| Mídia | Buffer completo era alocado antes de conferir 50 MB; concorrência global ilimitada | Quatro downloads por processo; excesso retorna 429, sem fila ilimitada. Consumo em stream limitado a 50 MB, prazo total de 45 segundos e aborto da rede. Resposta HTTP continua compatível |
| Consulta de sessão offline | Busca individual enumerava sessões do banco e arquivos | Consulta exata da chave de credenciais e caminho exato, sem varredura global por polling de número offline |
| Stream HTTP do provedor | `fetched.pipe(output)` não propagava erro do corpo original; socket remoto encerrado podia matar o processo | Patch de compatibilidade rc14 usa `pipeline`, propaga AbortSignal para fetch e cancela corpos HTTP rejeitados. Erro chega ao chamador; nenhum tratamento global que ignore exceções |

O patch da dependência está em `tools/patch-provider-streams.mjs`, executado por `postinstall`, `build` e `test`. É idempotente e interrompe instalação/build se versão ou contexto mudarem. O Docker copia `tools` antes de instalar dependências. Não basta copiar somente arquivos de `dist`: publique também manifestos e `tools`, execute instalação/build e reinicie a API.

## Comportamento solicitado ao desconectar

O evento de fechamento mantém o estado offline imediatamente. Pendências de importação daquela conexão são descartadas, a fila HTTP correspondente é abortada e trabalhos de resincronização são encerrados com `HISTORY_CONNECTION_CLOSED`. Downloads de mídia recebem cancelamento. Eventos de estado e outras conexões são preservados; épocas distinguem trabalho antigo de um novo pareamento.

Antes de cada lote/página e entrega de dados, o código confere a conexão. Nenhum próximo lote é iniciado após a desconexão. Uma escrita SQL que já estava em andamento pode terminar; dados já persistidos não são apagados. Um HTTP já recebido pelo backend exige também o bloqueio de importação implementado nele. No desligamento administrativo do processo, sem evento de desconexão do socket, continua existindo drenagem dos trabalhos para preservar a operação de reinício.

## Limites que continuam relevantes

- **Um processo por conjunto de sessões/fila.** `ecosystem.config.json` está em `instances: 1`, modo fork. Ownership, sockets e mutexes são locais. Aumentar o número de réplicas usando o mesmo banco/conjunto de sessões pode abrir o mesmo número em mais de um processo. Não há coordenador distribuído ou roteamento de sessões implementado.
- **Históricos grandes são diferentes de números ociosos.** Payloads recebidos do provedor ainda precisam existir em memória e há uma fila ordenada de eventos por instância. Não se deve parear/resincronizar 1.000 históricos grandes simultaneamente. O limite real depende de tamanho de mensagens, grupos, anexos e frequência de atualização.
- **A outbox ainda usa arquivos.** Metadados de agendamento crescem com quantidade de arquivos; a descoberta precisa listar/ler arquivos e há fsync por envelope. O corpo já não fica todo retido, mas milhões de arquivos continuam inadequados. Meça atraso de entrega, IOPS, espaço, quantidade de arquivos e dead-letter. Para crescer além da capacidade medida, será necessária fila/indexação durável particionada.
- **Banco compartilhado.** Signal, histórico e leitura de mídia usam PostgreSQL. Mensagens novas já usam lotes de até 100; contatos ainda exigem transações de mesclagem e chats conservam leitura/upsert. Dimensione pool total de todos os processos para não saturar o banco; não multiplique pools sem orçamento de conexões.
- **Restauração sequencial.** `Sessions.restore()` carrega sessões em sequência e readiness aguarda terminar. Isso limita o pico de inicialização, mas alonga reinício de muitos números. Aumentar concorrência só deve ocorrer com controle de admissão e testes do banco/provedor. Restore não é prova de que todos os sockets já autenticaram.
- **Buffers de resposta e demais caches da dependência.** Quatro downloads de 50 MB podem usar centenas de MB entre chunks, concatenação, criptografia e resposta; esse limite não equivale ao RSS total. Respostas para clientes lentos podem continuar ocupando buffers depois de preparar o resultado. Outros estados internos do SDK também existem. O proxy deve limitar conexões simultâneas e a API não deve ser exposta como serviço irrestrito de downloads.
- **Resincronização tem controle de produção.** O worker usa páginas de até 100 registros e pausa produção quando a outbox tem 50 itens; uma grande fila de eventos ao vivo pode, portanto, reduzir a velocidade de resincronizações. Isso protege armazenamento; aumentar esse número indiscriminadamente transfere o problema para disco e memória.
- **Encerramento tem prazo.** O processo limita shutdown a 25 segundos e PM2 a 30 segundos. Observe duração de drenagem e restauração antes de automatizar reinícios de um nó carregado.

## Crescimento recomendado para 8 CPUs / 16 GB compartilhados

Manter inicialmente um processo API, concorrência de mídia em quatro e fila durável. Reservar memória para backend, PostgreSQL, demais bancos, sistema e picos; não atribuir 16 GB de heap a um Node nessa máquina. O heap V8 não inclui toda a memória de buffers/sockets.

Medir por estágios de números reais consentidos (por exemplo, 25 → 50 → 100, aumentando conforme a folga observada). Em cada estágio medir: RSS e memória externa da API, heap após coleta normal, lag do event loop p95/p99, CPU, conexões e latência SQL, fila/idade do webhook, tempo de login/restauração, downloads 429/504, reconexões por minuto e disco disponível. Repetir um período ocioso e outro com conversa/histórico representativos; esperar estabilização da memória antes de extrapolar.

Calcular memória incremental por sessão como `(RSS estabilizado do estágio − RSS base)/sessões`, separando números com muitos grupos/históricos. Não multiplicar a média de sessões vazias para prever a pior carga. Definir admissão pelo menor limite observado entre CPU, memória, banco, disco e atraso de eventos, mantendo reserva para picos e reconexões.

Quando necessário, separar banco e API do backend para reduzir disputa. Para várias APIs, primeiro implementar atribuição exclusiva persistente de cada `owner/instanceName` a um nó e roteamento estável de todas as operações; cada nó precisa de fila própria. Failover exige lease distribuído e fencing para que o nó antigo não reconecte a sessão que mudou de proprietário. Isso é trabalho arquitetural futuro, não uma capacidade habilitada por esta atualização.

## Supervisão e reinício

`npm start` sozinho não supervisiona o processo. O arquivo PM2 existente usa `autorestart: true`, espera de 2 segundos, `min_uptime: 10000` e `max_restarts: 5`: cinco inicializações instáveis consecutivas podem deixá-lo em erro até intervenção. Esse limite evita um loop agressivo de configuração incorreta; revise alertas e o motivo antes de alterar o limite.

Escolha apenas um supervisor: aaPanel, PM2 **ou** systemd. Não coloque systemd reiniciando o Node enquanto aaPanel/PM2 também inicia a mesma API. Como alternativa ao PM2, este é um modelo systemd (substitua usuário, diretórios e executável pelos valores reais antes de instalar):

```ini
[Unit]
Description=ZapToBox WhatsApp API
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=USUARIO_DA_API
WorkingDirectory=/CAMINHO/DA/API
ExecStart=/CAMINHO/DO/node dist/main.js
Environment=NODE_ENV=production
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```

Reinício automático reduz indisponibilidade após falha; não substitui o patch de stream, diagnóstico nem controle de capacidade. Nenhum supervisor foi instalado ou alterado em produção nesta revisão.

## Validação reproduzível

`npm test` e `npm run build` aplicam o patch do provedor e executam/compilam o código atual. Casos adicionados:

- 1.000 caches independentes sob 200.000 inserções, com limites e expiração;
- 1.000 solicitações simultâneas ao orçamento de mídia: quatro executam, 996 recebem 429 e slots são liberados;
- 1.000 consultas offline por chave exata, sem inventário global (banco substituído por fixture);
- histórico grande cede worker até a 16ª entrega para outra instância;
- arquivo maior que o limite interrompe consumo, stream parado expira e logout cancela somente downloads da conexão escolhida;
- logout durante gravação/lote e leitura de página interrompe próximas etapas, preservando dados já escritos;
- descarte da outbox cancela HTTP antigo sem recriar retry, preservando outro tenant, eventos de estado e novo pareamento;
- processo filho recebe TCP encerrado no meio do corpo: SDK/controller rejeitam e o processo baixa um arquivo válido em seguida; fetch aborta antes dos headers.

As fixtures acima verificam limites, isolamento e falhas. Não equivalem a 1.000 sockets WhatsApp reais nem medem a capacidade de rede/IOPS do servidor de produção. Integrações opcionais com bancos precisam de ambientes isolados configurados.
