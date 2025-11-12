import {Request, Response, NextFunction} from "express";
import jwt from "jsonwebtoken";
import UserConfig from "../config/env";

export default class Token{

    async verify(req: Request, res: Response, next: NextFunction){
        const token = req.headers?.authorization?.replace(/^Bearer\s+/i, "");;
        const secret = UserConfig.jwtToken;
        
        if(!token || !secret || !jwt.verify(token, secret)){
            return res.status(401).json({
                error: "Invalid Token" 
            });
        }
        
        next();
    }

}