import * as fs from "fs";
import {InstanceInfo} from "../types/instance"
import {instances, sessionsPath} from "../server";
import path from "path";

export async function listInstances(ownerFilter?: string){

    const results: InstanceInfo[] = [];

    if(!fs.existsSync(sessionsPath)){
        return results;
    }

    const owners = (ownerFilter ? [ownerFilter] : await getOwnersPath(sessionsPath));

    for(const owner of owners){

        const ownerPath = path.join(sessionsPath, owner);

        if(!fs.existsSync(ownerPath)){
            continue;
        }

        const instancesDirs = await getOwnersPath(ownerPath);

        for(const instanceName of instancesDirs){

            const key = `${owner}_${instanceName}`;
            const loaded = instances[key];

            results.push({
                instanceName,
                owner,
                connectionStatus: loaded ? loaded.connectionStatus : "OFFLINE",
                profilePictureUrl: loaded ? loaded.profilePictureUrl : undefined
            });

        }

    }

    return results;

}

async function getOwnersPath(opath: string){
    return fs.readdirSync(opath).filter((f) => {
        try{
            return fs.statSync(path.join(opath, f)).isDirectory();
        }catch{
            return false;
        }
    });
}