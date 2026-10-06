/**
 * How a device proves who it is, and the request fields the device sends.
 *
 * A device has no user session. Every call carries its hardware id ("LT-" and
 * the last three bytes of its MAC) and the pairing token it showed in its QR
 * code, as x-hardware-id and x-pair-token headers. The token is the device's
 * secret: it is compared in constant time, and the account a device acts for
 * is always the owner of its devices row, never anything the request claims.
 */

import type { DeviceRow, Store } from "./store.ts";

const HARDWARE_ID = /^LT-[0-9A-Fa-f]{6}$/;
const HEX32 = /^[0-9a-fA-F]{32}$/;
const BOOK_ID = /^[0-9a-fA-F]{8,64}$/;

export interface DeviceCredentials {
  hardwareId: string;
  token: string;
}

/** The device's credentials from the request headers, or null when missing or malformed. */
export function deviceCredentials(req: Request): DeviceCredentials | null {
  const hardwareId = req.headers.get("x-hardware-id") ?? "";
  const token = req.headers.get("x-pair-token") ?? "";
  if (!HARDWARE_ID.test(hardwareId) || !HEX32.test(token)) return null;
  return { hardwareId, token: token.toLowerCase() };
}

/** Compares two secrets without leaking, through timing, how much of them matched. */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** The paired device these credentials belong to, or null. */
export async function authenticateDevice(
  store: Store,
  creds: DeviceCredentials,
): Promise<DeviceRow | null> {
  const device = await store.deviceByHardwareId(creds.hardwareId);
  return device && sameSecret(device.pairingToken, creds.token) ? device : null;
}

/** A recording session id: 32 hex characters, minted by the device for each take. */
export function sessionId(req: Request): string | null {
  const value = req.headers.get("x-session-id") ?? "";
  return HEX32.test(value) ? value.toLowerCase() : null;
}

/** The device's stable id for a book (16 hex characters today), or null when absent or malformed. */
export function bookId(req: Request): string | null {
  const value = req.headers.get("x-book-id") ?? "";
  return BOOK_ID.test(value) ? value.toLowerCase() : null;
}

/** A non-negative integer header, or null when absent or not a plain number. */
export function intHeader(req: Request, name: string, max = 1_000_000): number | null {
  const value = req.headers.get(name);
  if (value === null || !/^\d{1,7}$/.test(value)) return null;
  const n = Number(value);
  return n <= max ? n : null;
}

/** A display name from a header, trimmed and capped, or null when empty. */
export function textHeader(req: Request, name: string, maxLength = 100): string | null {
  const value = req.headers.get(name)?.trim() ?? "";
  return value ? value.slice(0, maxLength) : null;
}
