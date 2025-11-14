import express from "express";
import InstancesController from "../controllers/instances";

export default class InstanceRoutes{

    private router = express.Router();

    get(){
        
        const instancesController = new InstancesController();

        this.router
            .post("/create", instancesController.create)
            .get("/get", instancesController.get);

        return this.router;

    }

}