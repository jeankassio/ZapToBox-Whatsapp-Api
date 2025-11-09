import express from "express";
import dotenv from "dotenv";
import instanceRoutes from "./routes/instances";
import { initAllSessions } from "./services/baileysService";

dotenv.config();

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
