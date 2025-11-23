import {Request, Response, NextFunction} from "express";
import jwt from "jsonwebtoken";
import UserConfig from "../config/env";

export default class Token{

    async verify(req: Request, res: Response, next: NextFunction){
        const token = req.headers?.authorization?.replace(/^Bearer\s+/i, "");;
        const secret = UserConfig.jwtToken;
        
        if(!token || !secret){
            console.log("Token or secret is missing");
            return res.status(401).json({
                error: "Invalid Token" 
            });
        }

        try {
            jwt.verify(token, secret);
            next();
        } catch (error) {
            console.error("Token verification error:", error);
            return res.status(401).json({
                error: "Invalid Token" 
            });
        }
    }

}