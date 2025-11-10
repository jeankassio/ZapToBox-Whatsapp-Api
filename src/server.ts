import express from "express";
import instanceRoutes from "./routes/instances";
import { initAllSessions } from "./services/baileysService";
import path from "path";
import { ConnectionStatus, InstanceData } from "./types/instance";
import { verifyToken } from "./middlewares/auth";
import { PortConfig, SessionFolderName } from "./config/env.config";

export const sessionsPath = path.join(__dirname, "..", SessionFolderName);
export const instanceStatus = new Map<string, ConnectionStatus>();
export const instances: Record<string, InstanceData> = {};

const app = express();
app.use(express.json());

app.use((req, res, next) => {
    verifyToken(req, res, next);
});

app.use("/", instanceRoutes);

initAllSessions();

app.listen(PortConfig, async () => {
    console.log(`Servidor rodando na porta ${PortConfig}`);
});
