import { SocketController, RequestError, type ControllerDependencies } from './base.js';
import { downloadPublicMedia } from './remote-media.js';
import type { WASocket } from '@whiskeysockets/baileys';
import type { Contact } from '../../../shared/types.js';
import { instances } from '../../../shared/constants.js';
import { presenceJid, type PresenceSnapshot } from '../../baileys/presence-state.js';

export interface ProfileDependencies extends ControllerDependencies {
  onContact?: (contact: Contact, socket: WASocket) => Promise<Contact | void>;
  presenceSubscribe?: (remoteJid: string, socket: WASocket) => Promise<PresenceSnapshot>;
}

function contactJid(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{5,20}(?::\d{1,5})?@(?:s\.whatsapp\.net|lid)$/.test(value)) return;
  return value.replace(/:\d+@/, '@');
}
const phoneJid = (value: unknown) => { const id = contactJid(value); return id && /^\d{8,15}@s\.whatsapp\.net$/.test(id) ? id : undefined; };
function providerPhoneMatches(requested: string, resolved: string): boolean {
  if (requested === resolved) return true;
  const first = requested.split('@')[0]!, second = resolved.split('@')[0]!;
  const longer = first.length > second.length ? first : second, shorter = first.length > second.length ? second : first;
  return /^55[1-9]\d9\d{8}$/.test(longer) && /^55[1-9]\d\d{8}$/.test(shorter) && longer.slice(0, 4) + longer.slice(5) === shorter;
}

export default class ProfileController extends SocketController {
  constructor(owner: string, name: string, private readonly profileDependencies: ProfileDependencies = {}) { super(owner, name, profileDependencies); }
  contactName(remoteJid: string, name: string) { return this.perform('Contact name changed in WhatsApp.', async sock => {
    if (!/^\d{5,20}(?::\d{1,5})?@(?:s\.whatsapp\.net|lid)$/.test(remoteJid)) throw new RequestError(400, 'An individual WhatsApp contact is required.');
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) throw new RequestError(400, 'Invalid contact name.');
    if (typeof sock.addOrEditContact !== 'function') throw new RequestError(501, 'Contact editing is unavailable in this WhatsApp provider.');
    const id = remoteJid.replace(/:\d+@/, '@'), fullName = name.trim();
    const existing = await this.repository!.getContactById(this.instance, id);
    if (this.sock !== sock) throw new RequestError(409, 'Instance connection changed during contact lookup.');
    // rc14 waits for the app-state IQ response and persists its version before
    // resolving. A rejected/uncertain provider operation must not become a local rename.
    await sock.addOrEditContact(id, { fullName, saveOnPrimaryAddressbook: true });
    const accepted: Contact = { id, name: fullName, savedName: fullName, savedNameUpdatedAt: new Date().toISOString(), nameSource: 'saved',
      ...(existing?.phoneNumber ? { phoneNumber: existing.phoneNumber } : {}), ...(existing?.lid && existing.lid !== id ? { lid: existing.lid } : {}) };
    try {
      if (this.sock !== sock) throw new RequestError(409, 'Instance connection changed after contact update.');
      const contact = this.profileDependencies.onContact ? await this.profileDependencies.onContact(accepted, sock)
        : await instances[this.instance]!.publishContact(accepted, sock);
      return { contact: contact ?? accepted, syncedToWhatsApp: true };
    } catch {
      // The remote change was already accepted. Preserve that fact so callers
      // can persist the returned snapshot without blindly repeating the mutation.
      return { contact: accepted, syncedToWhatsApp: true, syncPending: true };
    }
  }); }
  onWhatsapp(remoteJid: string) { return this.perform('Contact lookup completed.', async sock => {
    const queriedJid = contactJid(remoteJid);
    if (!queriedJid || (queriedJid.endsWith('@s.whatsapp.net') && !phoneJid(queriedJid))) throw new RequestError(400, 'An individual WhatsApp contact is required.');
    const assertCurrent = () => { if (this.sock !== sock) throw new RequestError(409, 'Instance connection changed during contact lookup.'); };
    const own = [sock.user, sock.authState?.creds.me];
    const ownPhone = own.map(contact => phoneJid(contact?.id)).find(Boolean);
    const ownLid = own.flatMap(contact => [contactJid(contact?.lid), contactJid(contact?.id)]).find(id => id?.endsWith('@lid'));
    // Connected socket identity is sufficient for an exact self lookup. A
    // Brazilian spelling variant still requires a positive provider lookup.
    if (ownPhone && (queriedJid === ownPhone || queriedJid === ownLid)) {
      const notify = own.map(contact => contact?.name).find(name => typeof name === 'string' && name.trim());
      return { id: ownLid ?? ownPhone, phoneNumber: ownPhone, queriedJid, lookupSource: 'self', ...(notify ? { notify, nameSource: 'notify' } : {}) };
    }
    const resolveContact = async (contact: Contact, lookupSource: 'cache' | 'provider') => {
      const id = contactJid(contact.id), explicitLid = contactJid(contact.lid);
      const lid = explicitLid?.endsWith('@lid') ? explicitLid : id?.endsWith('@lid') ? id : undefined;
      let phoneNumber = phoneJid(contact.phoneNumber) ?? phoneJid(id);
      if (!phoneNumber && lid) {
        // rc14 reverse lookup reads its already-known LID mapping only; it does
        // not send another USync query or invent a phone from the LID digits.
        phoneNumber = phoneJid(await sock.signalRepository?.lidMapping?.getPNForLID(lid));
        assertCurrent();
      }
      const matched = phoneNumber && (queriedJid.endsWith('@lid') ? queriedJid === lid
        : lookupSource === 'provider' ? providerPhoneMatches(queriedJid, phoneNumber) : queriedJid === phoneNumber);
      if (!matched || (id?.endsWith('@s.whatsapp.net') && id !== phoneNumber) || (id?.endsWith('@lid') && id !== lid)) throw new RequestError(502, 'The contact address could not be confirmed.');
      return { ...contact, id: id ?? lid ?? phoneNumber!, phoneNumber: phoneNumber!, ...(contact.lid !== undefined ? { lid } : {}), queriedJid, lookupSource };
    };
    const contact = await this.repository!.getContactById(this.instance, queriedJid);
    assertCurrent();
    if (contact) return resolveContact(contact, 'cache');
    if (queriedJid.endsWith('@lid')) return resolveContact({ id: queriedJid }, 'cache');
    const results = await sock.onWhatsApp(queriedJid);
    assertCurrent();
    const confirmed = results?.filter(entry => entry?.exists === true) ?? [];
    if (!confirmed.length) throw new RequestError(404, 'Contact not found on WhatsApp.');
    if (confirmed.length !== 1) throw new RequestError(502, 'The contact lookup returned an ambiguous result.');
    return resolveContact({ id: confirmed[0]!.jid }, 'provider');
  }); }
  fetchStatus(remoteJid: string) { return this.perform('Status fetched.', async sock => ({ status: await sock.fetchStatus(remoteJid) })); }
  fetchProfilePicture(remoteJid: string) { return this.perform('Profile picture fetched.', async sock => {
    try {
      const status = await sock.profilePictureUrl(remoteJid, 'image', 10_000) ?? null;
      if (this.sock !== sock) throw new RequestError(409, 'Instance connection changed during profile picture lookup.');
      return { status };
    }
    catch (error) {
      if (this.sock !== sock) throw new RequestError(409, 'Instance not connected.');
      const status = (error as { output?: { statusCode?: number } })?.output?.statusCode;
      // An absent/restricted picture is a normal contact state, not a failed
      // connection. The caller may also try the contact's known LID/PN alias.
      if (status === 404 || status === 403) return { status: null };
      throw error;
    }
  }); }
  fetchBusinessProfile(remoteJid: string) { return this.perform('Business profile fetched.', async sock => ({ profile: await sock.getBusinessProfile(remoteJid) })); }
  presenceSubscribe(remoteJid: string) { return this.perform('Presence subscribed.', async sock => {
    const id = presenceJid(remoteJid);
    if (!id) throw new RequestError(400, 'An individual WhatsApp contact is required.');
    const snapshot = this.profileDependencies.presenceSubscribe
      ? await this.profileDependencies.presenceSubscribe(id, sock)
      : await instances[this.instance]!.subscribePresence(id, sock);
    if (this.sock !== sock) throw new RequestError(409, 'Instance connection changed during presence subscription.');
    return snapshot;
  }); }
  profileName(name: string) { return this.perform('Profile name changed.', async sock => { await sock.updateProfileName(name); }); }
  profileStatus(status: string) { return this.perform('Profile status changed.', async sock => { await sock.updateProfileStatus(status); }); }
  updateProfilePicture(remoteJid: string, url: string) { return this.perform('Profile picture changed.', async sock => { await sock.updateProfilePicture(remoteJid, await downloadPublicMedia(url)); }); }
  removeProfilePicture(remoteJid: string) { return this.perform('Profile picture removed.', async sock => { await sock.removeProfilePicture(remoteJid); }); }
}
