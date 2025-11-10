import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProxyAgent as UndiciProxyAgent } from 'undici';
import { ProxyAgent } from '../types/proxy';

export function genProxy(wppProxy?: string, fetchProxy?: string): ProxyAgent{

    const proxys: ProxyAgent = {};

    const isProtocol = (url: string) => url.split(":")[0]?.toLowerCase();

    if(wppProxy){

        const protocol = isProtocol(wppProxy);

        switch(protocol){
            case 'http':
            case 'https':{
                proxys.wsAgent = new HttpsProxyAgent(wppProxy);
            }
            case 'socks':
            case 'socks4':
            case 'socks5':{
                proxys.wsAgent = new SocksProxyAgent(wppProxy);
            }
            default:{
                console.warn(`Unknown Protocol in Proxy: ${wppProxy}`);
            }
        }

    }

    if(fetchProxy){
        const protocol = isProtocol(fetchProxy);
        switch(protocol){
            case 'http':
            case 'https':
            case 'socks':
            case 'socks4':
            case 'socks5':{
                proxys.fetchAgent = new UndiciProxyAgent(fetchProxy);
            }
            default:{
                console.warn(`Unknown Protocol in Proxy: ${fetchProxy}`);
            }
        }
    }

    return proxys;
}