import express from "express";
import { createInstanceController, getInstanceList } from "../controllers/instancesController";

const router = express.Router();

router
    .post("/createInstance", createInstanceController)
    .get("/getInstances", getInstanceList);

export default router;
