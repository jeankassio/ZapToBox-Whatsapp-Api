import express from "express";
import { createInstanceController } from "../controllers/instancesController";

const router = express.Router();

router
    .post("/createInstance", createInstanceController);

export default router;
