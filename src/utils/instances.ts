import * as fs from "fs";

export async function removeInstancePath(instancePath: string){

    fs.rmSync(instancePath, { recursive: true, force: true });

}