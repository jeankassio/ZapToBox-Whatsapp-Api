import { webhookOutbox } from "../../shared/utils.js";

export default class Queue {
  start(): void { webhookOutbox.start(); }
  async stop(): Promise<void> { await webhookOutbox.stop(); }
}
