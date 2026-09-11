import type { AuthenticationCreds } from '@whiskeysockets/baileys';

/** QR pairing persists a signed account and device identity without setting registered. */
export function hasLinkedCredentials(
  creds: Partial<Pick<AuthenticationCreds, 'registered' | 'me' | 'account'>> | null | undefined,
): boolean {
  // A requested pairing code already sets me, but has no signed account until
  // the phone confirms it. Do not restore that incomplete pairing at startup.
  return creds?.registered === true || Boolean(
    typeof creds?.me?.id === 'string' && creds.me.id.trim() && creds.account,
  );
}
