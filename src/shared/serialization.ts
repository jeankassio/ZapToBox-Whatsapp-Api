import { BufferJSON } from "@whiskeysockets/baileys";

/** Retains protobuf bytes and BigInt instead of discarding the whole event. */
export function stringify(value: unknown): string {
  return JSON.stringify(value, jsonReplacer);
}

export function jsonReplacer(key:string,item:unknown):unknown {
  if(typeof item === "bigint") return item.toString();
  // BufferJSON output may cross the database and outbox more than once.
  if(item && typeof item === "object" && (item as {type?:string}).type === "Buffer"
    && typeof (item as {data?:unknown}).data === "string") return item;
  return BufferJSON.replacer(key,item);
}

export function jsonValue<T = unknown>(value: unknown): T {
  return JSON.parse(stringify(value)) as T;
}

export function timestampBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (value && typeof value === "object") {
    const long = value as { low?: number; high?: number; toString?: () => string };
    const rendered = long.toString?.();
    if (rendered && /^\d+$/.test(rendered)) return BigInt(rendered);
    if (typeof long.low === "number" && typeof long.high === "number") {
      return (BigInt(long.high >>> 0) << 32n) + BigInt(long.low >>> 0);
    }
  }
  return 0n;
}
