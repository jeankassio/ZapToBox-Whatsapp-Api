import {Request, Response, NextFunction} from "express";
import jwt from "jsonwebtoken";
import { JwtToken } from "../config/env.config";

export function verifyToken(req: Request, res: Response, next: NextFunction){

    const token = req.headers?.authorization?.replace(/^Bearer\s+/i, "");;
    const secret = JwtToken;
    
    if(!token || !secret || !jwt.verify(token, secret)){
        return res.status(401).json({
            error: "Invalid Token" 
        });
    }
    
    next();

}