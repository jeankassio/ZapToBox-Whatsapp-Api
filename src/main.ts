import express from "express";
import Token from "./infra/state/auth";
import InstanceRoutes from "./infra/http/routes/instances";
import MessageRoutes from "./infra/http/routes/messages";
import UserConfig from "./infra/config/env";
import Sessions from "./infra/state/sessions";
import Queue from "./infra/webhook/queue";
import MediaRoutes from "./infra/http/routes/media";
import ChatRoutes from "./infra/http/routes/chat";

async function bootstrap(){

    const app = express();
    app.use(express.json());

    app.use((req, res, next) => {
        (new Token).verify(req, res, next);
    });

    app.use("/instances/", (new InstanceRoutes).get());
    app.use("/messages/", (new MessageRoutes).get());
    app.use("/media/", (new MediaRoutes).get());
    app.use("/chat/", (new ChatRoutes).get());

    app.listen(UserConfig.portConfig, async () => {
        await (new Sessions).start();
        (new Queue).start();
        console.log(`Server running in port ${UserConfig.portConfig}`);
    });

}

bootstrap();