import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type HistoryRescanJob } from '@prisma/client';
import { getContentType, proto } from '@whiskeysockets/baileys';
import { ContactMapper } from '../mappers/contactMapper.js';
import { MessageMapper, serializeBaileys, isEditedMessage, sourceEdit } from '../mappers/messageMapper.js';
import { RequestError } from '../http/controllers/base.js';
import { zeroCounts, type RescanJob, type RescanKind, type RescanPending, type RescanState, type RescanStore } from './service.js';

const convert = (row: HistoryRescanJob): RescanJob => ({ ...row, state: row.state as unknown as RescanState, pending: row.pending as unknown as RescanPending | null });
export class PrismaRescanStore implements RescanStore {
  constructor(private readonly db: PrismaClient) {}
  async cancelInstance(instance: string, before: Date): Promise<void> {
    await this.db.historyRescanJob.updateMany({ where: { instance, status: { in: ['queued', 'running'] }, createdAt: { lte: before } }, data: {
      status: 'failed', errorCode: 'HISTORY_CONNECTION_CLOSED', activeInstance: null, leaseToken: null, leaseUntil: null, pending: Prisma.DbNull, completedAt: before,
    } });
  }
  async begin(instance: string, key: string, known: boolean, now: Date): Promise<RescanJob> {
    try {
      return await this.db.$transaction(async tx => {
        const prior = await tx.historyRescanJob.findUnique({ where: { instance_idempotencyKey: { instance, idempotencyKey: key } } });
        if (prior) return convert(prior);
        if (await tx.historyRescanJob.findUnique({ where: { activeInstance: instance } })) throw new RequestError(409, 'A history rescan is already in progress for this instance.');
        const [contacts, chats, messages] = await Promise.all([
          tx.contact.aggregate({ where: { instance }, _count: { id: true }, _max: { id: true } }),
          tx.chat.aggregate({ where: { instance }, _count: { id: true }, _max: { id: true } }),
          tx.message.aggregate({ where: { instance }, _count: { id: true }, _max: { id: true } }),
        ]);
        if (!known && !contacts._count.id && !chats._count.id && !messages._count.id) throw new RequestError(404, 'Instance history not found.');
        const state: RescanState = { phase: 'contacts', cursor: zeroCounts(), max: { contacts: contacts._max.id ?? 0, chats: chats._max.id ?? 0, messages: messages._max.id ?? 0 },
          available: { contacts: contacts._count.id, chats: chats._count.id, messages: messages._count.id }, scanned: zeroCounts(), counts: zeroCounts(), chunks: 0, sequence: 0 };
        return convert(await tx.historyRescanJob.create({ data: { id: randomUUID(), instance, idempotencyKey: key, activeInstance: instance, runId: randomUUID(),
          state: state as unknown as Prisma.InputJsonValue, createdAt: now, nextAttemptAt: now } }));
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 });
    } catch (error) {
      if ((error as { code?: string })?.code !== 'P2002') throw error;
      const prior = await this.db.historyRescanJob.findUnique({ where: { instance_idempotencyKey: { instance, idempotencyKey: key } } });
      if (prior) return convert(prior);
      if (await this.db.historyRescanJob.findUnique({ where: { activeInstance: instance } })) throw new RequestError(409, 'A history rescan is already in progress for this instance.');
      throw error;
    }
  }
  async get(instance: string, jobId: string) {
    const row = await this.db.historyRescanJob.findFirst({ where: { id: jobId, instance } }); return row ? convert(row) : null;
  }
  private eligible(now: Date): Prisma.HistoryRescanJobWhereInput {
    return { activeInstance: { not: null }, nextAttemptAt: { lte: now }, OR: [{ status: 'queued' }, { status: 'running', leaseUntil: { lte: now } }] };
  }
  async next(now: Date) {
    return (await this.db.historyRescanJob.findFirst({ where: this.eligible(now), orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }], select: { id: true } }))?.id ?? null;
  }
  async claim(id: string, token: string, until: Date, now: Date) {
    const result = await this.db.historyRescanJob.updateMany({ where: { id, ...this.eligible(now) }, data: { status: 'running', leaseToken: token, leaseUntil: until } });
    if (!result.count) return null;
    const row = await this.db.historyRescanJob.findFirst({ where: { id, leaseToken: token } }); return row ? convert(row) : null;
  }
  async renew(id: string, token: string, until: Date) {
    return (await this.db.historyRescanJob.updateMany({ where: { id, leaseToken: token, status: 'running' }, data: { leaseUntil: until } })).count > 0;
  }
  async stage(id: string, token: string, pending: RescanPending) {
    return (await this.db.historyRescanJob.updateMany({ where: { id, leaseToken: token, status: 'running', pending: { equals: Prisma.DbNull } }, data: { pending: pending as unknown as Prisma.InputJsonValue } })).count > 0;
  }
  async advance(id: string, token: string, pending: RescanPending, now: Date) {
    return (await this.db.historyRescanJob.updateMany({ where: { id, leaseToken: token, status: 'running' }, data: {
      state: pending.after as unknown as Prisma.InputJsonValue, pending: Prisma.DbNull, errorCode: null,
      ...(pending.complete ? { status: 'completed', completedAt: now, activeInstance: null, leaseToken: null, leaseUntil: null } : {}),
    } })).count > 0;
  }
  async release(id: string, token: string, now: Date) {
    // Yield between bounded page batches so another connection can make progress.
    await this.db.historyRescanJob.updateMany({ where: { id, leaseToken: token, status: 'running' }, data: { status: 'queued', leaseToken: null, leaseUntil: null, nextAttemptAt: now } });
  }
  async fail(id: string, token: string, code: string, retryAt: Date, terminal: boolean) {
    await this.db.historyRescanJob.updateMany({ where: { id, leaseToken: token, status: 'running' }, data: { status: terminal ? 'failed' : 'queued', attempts: { increment: 1 }, errorCode: code,
      nextAttemptAt: retryAt, leaseToken: null, leaseUntil: null, ...(terminal ? { activeInstance: null, pending: Prisma.DbNull } : {}) } });
  }
  async page(instance: string, kind: RescanKind, after: number, maximum: number, take: number): Promise<Array<{ id: number; data: unknown | null }>> {
    const query = { where: { instance, id: { gt: after, lte: maximum } }, orderBy: { id: 'asc' as const }, take };
    if (kind === 'contacts') return (await this.db.contact.findMany(query)).map(row => ({ id: row.id, data: row.jid || row.lid ? ContactMapper.toContact(row) : null }));
    if (kind === 'chats') return (await this.db.chat.findMany(query)).map(row => ({ id: row.id, data: { ...(typeof row.data === 'object' && row.data && !Array.isArray(row.data) ? row.data : {}), id: row.jid } }));
    return (await this.db.message.findMany(query)).map(row => {
      const message = MessageMapper.toWAMessage(row), protocol = message.message?.protocolMessage;
      const visible = message.message && !message.message.senderKeyDistributionMessage && (!protocol || protocol.type === proto.Message.ProtocolMessage.Type.REVOKE || protocol.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT);
      const marker = sourceEdit((row.content as Record<string, unknown>)?.sourceEdit);
      return { id: row.id, data: visible ? { ...serializeBaileys(message), messageType: getContentType(message.message!),
        ...(isEditedMessage(message.message) ? { edited: true } : {}), ...(marker ? { sourceEdit: marker } : {}) } : null };
    });
  }
}
