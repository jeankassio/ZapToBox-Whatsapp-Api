import * as fs from "fs";
import { instances, sessionsPath } from "../../shared/constants";
import path from "path";
import Instance from "../baileys/services";

export default class Sessions{

    async start(){

        if (!fs.existsSync(sessionsPath)) fs.mkdirSync(sessionsPath);

        const owners = fs.readdirSync(sessionsPath);
        for (const owner of owners) {
            const ownerPath = path.join(sessionsPath, owner);
            const instancesDirs = fs.readdirSync(ownerPath);
            for (const instanceName of instancesDirs) {
                const key = `${owner}_${instanceName}`;
                instances[key] = new Instance;
                await instances[key].create({ owner, instanceName, phoneNumber: undefined });
            }
        }

    }

}