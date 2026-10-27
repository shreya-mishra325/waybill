import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const newToken = () => randomBytes(32).toString("base64url");
export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const validToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export function tokensEqual(left: string, right: string) {
  return timingSafeEqual(Buffer.from(tokenHash(left), "hex"), Buffer.from(tokenHash(right), "hex"));
}
export function cookieToken(header: string | undefined, name: string) {
  const values = (header ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(name + "=")).map(part => part.slice(name.length + 1));
  return values.length === 1 && validToken(values[0]) ? values[0] : undefined;
}
export function cookieNames(secure: boolean) {
  return { session: secure ? "__Host-waybill-session" : "waybill-session", oauth: secure ? "__Host-waybill-oauth" : "waybill-oauth" };
}
