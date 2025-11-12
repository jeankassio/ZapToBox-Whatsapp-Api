import express from "express";
import Token from "./infra/state/auth";
import InstanceRoutes from "./infra/http/routes/instances";
import UserConfig from "./infra/config/env";
import Sessions from "./infra/state/sessions";
import Queue from "./infra/webhook/queue";

async function bootstrap(){

    const app = express();
    app.use(express.json());

    app.use((req, res, next) => {
        (new Token).verify(req, res, next);
    });

    app.use("/", (new InstanceRoutes).get());

    app.listen(UserConfig.portConfig, async () => {
        await (new Sessions).start();
        console.log(`Server running in port ${UserConfig.portConfig}`);
        (new Queue).start();
    });

}

bootstrap();