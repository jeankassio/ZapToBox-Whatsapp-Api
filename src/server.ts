import express from "express";
import dotenv from "dotenv";
import instanceRoutes from "./routes/instances";
import { initAllSessions } from "./services/baileysService";
import path from "path";
import { ConnectionStatus, InstanceData } from "./types/instance";

dotenv.config();

const sessionName = process.env.SESSION_FOLDER_NAME || "sessions";
export const sessionsPath = path.join(__dirname, "..", sessionName);
export const instanceStatus = new Map<string, ConnectionStatus>();
export const instances: Record<string, InstanceData> = {};

const app = express();
app.use(express.json());

app.use((req, res, next) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token || token !== process.env.API_TOKEN) {
        return res.status(401).json({
             error: "Invalid Token" 
        });
    }
    next();
});

app.use("/", instanceRoutes);

initAllSessions();

const PORT = process.env.PORT || 3005;
app.listen(PORT, async () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
