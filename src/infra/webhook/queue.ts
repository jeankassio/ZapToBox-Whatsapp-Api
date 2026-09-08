import { webhookOutbox } from "../../shared/utils.js";
import { historyRescan } from '../history-rescan/index.js';

export default class Queue {
  start(): void { webhookOutbox.start(); historyRescan.start(); }
  async stop(): Promise<void> { await historyRescan.stop(); await webhookOutbox.stop(); }
}
