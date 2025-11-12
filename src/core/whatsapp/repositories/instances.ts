import * as fs from "fs";
import path from "path";
import { InstanceInfo } from "../../../shared/types";
import { instanceConnection, sessionsPath } from "../../../shared/constants";

export default class InstancesRepository {
    
    async list(ownerFilter?: string): Promise<InstanceInfo[]> {

        const results: InstanceInfo[] = [];

        if(!fs.existsSync(sessionsPath)){
            return results;
        }

        const owners = (ownerFilter ? [ownerFilter] : await this.getOwnersPath(sessionsPath));

        for(const owner of owners){

            const ownerPath = path.join(sessionsPath, owner);

            if(!fs.existsSync(ownerPath)){
                continue;
            }

            const instancesDirs = await this.getOwnersPath(ownerPath);

            for(const instanceName of instancesDirs){

                const key = `${owner}_${instanceName}`;
                const loaded = instanceConnection[key];

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

    async getOwnersPath(opath: string): Promise<string[]> {
        return fs.readdirSync(opath).filter((f) => {
            try{
                return fs.statSync(path.join(opath, f)).isDirectory();
            }catch{
                return false;
            }
        });
    }
    
}
