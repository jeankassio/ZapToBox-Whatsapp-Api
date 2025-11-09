import {Router, Request, Response} from "express";
import { verifyToken } from "./middlewares/auth";

const router = Router();

router.use(verifyToken);

router
    .get("/ping", (req: Request, res: Response) => {

        res.json({
            message: "pong",
            method: "GET"
        });

    })
    .post("/echo", (req: Request, res: Response) => {

        res.json({
            message: "ready",
            method: "POST",
            dataReceived: req.body
        });

    });

export default router;