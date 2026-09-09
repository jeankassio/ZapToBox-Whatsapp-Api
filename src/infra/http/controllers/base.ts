import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import PrismaConnection from '../../../core/connection/prisma.js';
import { instances, instanceStatus } from '../../../shared/constants.js';
import { instanceKey } from '../../../shared/identity.js';

export class RequestError extends Error {
  constructor(public statusCode: number, message: string, public code?: string) { super(message); }
}
export type ControllerResult = { success: boolean; message?: string; error?: string; statusCode?: number; data?: any; [key: string]: any };
export interface ControllerDependencies {
  socket?: WASocket;
  repository?: Pick<typeof PrismaConnection, 'getMessageById' | 'getLastMessageByInstance' | 'getContactById'>;
  onSent?: (message: WAMessage) => Promise<void>;
}
export class SocketController {
  protected readonly instance: string;
  protected readonly dependencies: ControllerDependencies;
  protected readonly repository: ControllerDependencies['repository'];
  constructor(owner: string, name: string, dependencies: ControllerDependencies = {}) {
    this.instance = instanceKey(owner, name);
    this.dependencies = dependencies;
    this.repository = dependencies.repository ?? PrismaConnection;
  }
  protected get sock(): WASocket {
    const sock = this.dependencies.socket ?? instances[this.instance]?.getSock();
    if (!sock || (!this.dependencies.socket && instanceStatus.get(this.instance) !== 'ONLINE') || (sock.ws && !sock.ws.isOpen)) throw new RequestError(409, 'Instance not connected.');
    return sock;
  }
  protected async stored(messageId: string, remoteJid?: string): Promise<WAMessage> {
    const message = await this.repository!.getMessageById(messageId, this.instance, remoteJid);
    if (!message) throw new RequestError(404, 'Message not found in this instance and chat.');
    return message;
  }
  protected async perform(message: string, action: (sock: WASocket) => Promise<any>): Promise<ControllerResult> {
    try {
      const data = await action(this.sock);
      return { success: true, message, ...(data === undefined ? {} : { data }) };
    } catch (error) {
      return { success: false, error: error instanceof RequestError ? error.message : 'The WhatsApp operation failed.', statusCode: error instanceof RequestError ? error.statusCode : 502 };
    }
  }
  protected async persistSent(message: WAMessage): Promise<void> {
    if (this.dependencies.onSent) await this.dependencies.onSent(message);
    else await instances[this.instance]!.publishSentMessage(message);
  }
}
