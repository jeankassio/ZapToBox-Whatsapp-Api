import {Request, Response, NextFunction} from "express";

export function verifyToken(req: Request, resp: Response, next: NextFunction){

    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if(!token || token !== process.env.API_TOKEN){
        return resp.status(401).json({
            error: "Invalid Token"
        });
    }

    next();

}