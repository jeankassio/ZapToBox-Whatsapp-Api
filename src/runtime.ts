import type { Server } from 'node:http';

export interface RuntimeDependencies {
  server: Server;
  host: string;
  port: number;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  queue: { start(): void; stop(): Promise<void> };
  sessions: { start(): Promise<void>; shutdown(): Promise<void> };
}

/** Own the HTTP port before opening storage or restoring any WhatsApp session. */
export class ApiRuntime {
  ready = false;
  bound = false;
  private closing = false;
  private starting: Promise<void> | undefined;
  private binding: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;

  constructor(private readonly dependencies: RuntimeDependencies) {}

  start(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('API is shutting down'));
    return this.starting ??= this.initialize();
  }

  private async initialize(): Promise<void> {
    const { server, host, port, connect, queue, sessions } = this.dependencies;
    this.binding = new Promise<void>((resolve, reject) => {
      const cleanup = () => { server.off('error', failed); server.off('listening', listening); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const listening = () => { this.bound = true; cleanup(); resolve(); };
      server.once('error', failed);
      server.once('listening', listening);
      try { server.listen({ port, host, exclusive: true }); }
      catch (error) { cleanup(); reject(error); }
    });
    await this.binding;
    if (this.closing) return;
    await connect();
    if (this.closing) return;
    queue.start();
    await sessions.start();
    if (!this.closing) this.ready = true;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closing = true;
    this.ready = false;
    return this.stopping = this.cleanup();
  }

  private async cleanup(): Promise<void> {
    const { server, sessions, queue, disconnect } = this.dependencies;
    await this.binding?.catch(() => {});
    const failures: unknown[] = [];
    const attempt = async (action: () => Promise<void>) => { try { await action(); } catch (error) { failures.push(error); } };
    // Drain HTTP requests while their sockets/database are still usable.
    await attempt(() => new Promise<void>((resolve, reject) => {
      server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      server.closeIdleConnections();
    }));
    this.bound = false;
    // shutdown() cancels the session restore loop, including a restore in flight.
    await attempt(() => sessions.shutdown());
    await this.starting?.catch(() => {});
    await attempt(() => queue.stop());
    await attempt(disconnect);
    if (failures.length) throw new AggregateError(failures, 'API cleanup failed');
  }
}

export function startupErrorMessage(error: unknown, host: string, port: number): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'EADDRINUSE') return `A porta ${host}:${port} já está em uso. Reinicie a instância existente no painel/PM2 antes de iniciar outra. Execute npm run diagnose para verificar a porta. Este processo não iniciou sessões WhatsApp nem a fila de webhooks.`;
  if (code === 'EACCES') return `Sem permissão para escutar em ${host}:${port}. Confira HOST/PORT e a porta autorizada pela hospedagem.`;
  return error instanceof Error ? error.message : 'Unknown error';
}
