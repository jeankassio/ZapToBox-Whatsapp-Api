import {WAMessage, WAMessageKey, WASocket} from "@whiskeysockets/baileys";
import { BlobOptions } from "buffer";

export type ConnectionStatus = "ONLINE" | "OFFLINE" | "REMOVED";
export type ConnectionState = 'connected' | 'reconnecting' | 'pairing' | 'disconnected';
export type StatusPresence = "available" | "unavailable" | "composing" | "recording" | "paused";

export interface InstanceInfo {
  instanceName: string;
  owner: string;
  connectionStatus: ConnectionStatus;
  /** Distinguishes retained credentials under recovery from a revoked or stopped session. */
  connectionState?: ConnectionState;
  /** Time the current transport state was observed, independent of webhook delivery delays. */
  connectionUpdatedAt?: string;
  profilePictureUrl?: string | undefined;
  instanceJid?: string | null;
}

export interface InstanceData extends InstanceInfo{
  socket?: WASocket;
}

export type InstanceCreated = {
  success: boolean;
  message?: string;
  error?: string;
  instance?: InstanceInfo;
  qrCode?: string;
  pairingCode?: string;
}

export interface WebhookPayload {
  event: string;
  instance: InstanceInfo;
  data: unknown;
  targetUrl: string;
  id?: string;
  timestamp?: string;
  history?: HistoryChunkMetadata;
}

export interface HistoryChunkMetadata {
  source?: 'stored-history';
  runId: string;
  startedAt: string;
  batchId: string;
  chunkId: string;
}

export interface MessageWebhook extends WAMessage{
  messageType?: string;
}

export interface ProxyAgent{
  wsAgent?: any,
  fetchAgent?: any
}

export interface Contact{
  id?: string;
  name?: string;
  lid?: string;
  phoneNumber?: string;
}

export interface ForwardMessage{
  forward: string
}

interface MentionUser{
  mentions?: string[]
}

interface ViewOnceMessage{
  viewOnce?: boolean
}

export interface TextMessage extends MentionUser{
  text: string
}

export interface LocationMessage{
  location: {
    degreesLatitude: number,
    degreesLongitude: number,
    name?: string,
    address?: string
  }
}

export interface ContactMessage{
  displayName: string,
  waid: number,
  phoneNumber: string
}

export interface ReactionMessage{
  emoji: string,
  messageId: string
}

export interface PinMessage{
  pin:{
    type: number,
    time: number,
    key: WAMessageKey
  }
}

export interface PollMessage{
  poll:{
    name: string,
    values: string[],
    selectableCount: number,
    toAnnouncementGroup: boolean
  }
}

export interface ImageMessage extends ViewOnceMessage{
  image:{
    url: string
  },
  caption?: string
}

export interface VideoMessage extends ViewOnceMessage{
  video:{
    url: string
  },
  caption?: string,
  ptv?: boolean
}

export interface GifMessage extends VideoMessage{
  gifPlayback: boolean
}

export interface AudioMessage extends ViewOnceMessage{
  audio:{
    url: string
  },
  mimetype: string,
  ptv?: boolean
}

export interface DocumentMessage{
  document:{
    url: string
  },
  mimetype: string,
  fileName: string
}

export interface StickerMessage{
  sticker:{
    url: string
  },
  isAnimated?: boolean
}
