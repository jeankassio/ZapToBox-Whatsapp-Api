import { instanceStatus } from "../../shared/constants";
import { ConnectionStatus } from "../../shared/types";
import { startWebhookRetryLoop } from "../../shared/utils";

export default class Queue{

    async start(){
        startWebhookRetryLoop(this.getInstanceStatus);
    }

    getInstanceStatus(name: string): ConnectionStatus{
        return instanceStatus.get(name) || "OFFLINE";
    }

}