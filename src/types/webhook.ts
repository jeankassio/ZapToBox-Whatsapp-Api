import { InstanceInfo } from "./instance";

export interface WebhookPayload {
  event: string;
  instance: InstanceInfo;
  data: any[];
  targetUrl: string;
}