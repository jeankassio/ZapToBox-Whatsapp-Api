import { pino } from 'pino';
import UserConfig from '../config/env.js';
import { createSafeLogger, instanceReference, type LogObserver } from './safe-logger.js';

export const apiLogger = createSafeLogger(pino({ level: UserConfig.whatsapp.logLevel }), { source: 'api' }, UserConfig.whatsapp.redactIdentifiers);
export const instanceLogger = (key: string) => apiLogger.child({ instanceRef: instanceReference(key) });
export function providerLogger(key: string, observer: LogObserver) {
  return createSafeLogger(pino({ level: UserConfig.whatsapp.baileysLogLevel }),
    { source: 'baileys', instanceRef: instanceReference(key) }, UserConfig.whatsapp.redactIdentifiers, observer);
}
