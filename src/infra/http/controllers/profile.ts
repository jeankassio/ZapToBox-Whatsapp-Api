import { SocketController, RequestError, type ControllerDependencies } from './base.js';
import { downloadPublicMedia } from './remote-media.js';
import type { WASocket } from '@whiskeysockets/baileys';
import type { Contact } from '../../../shared/types.js';
import { instances } from '../../../shared/constants.js';

export interface ProfileDependencies extends ControllerDependencies {
  onContact?: (contact: Contact, socket: WASocket) => Promise<Contact | void>;
}

export default class ProfileController extends SocketController {
  constructor(owner: string, name: string, private readonly profileDependencies: ProfileDependencies = {}) { super(owner, name, profileDependencies); }
  contactName(remoteJid: string, name: string) { return this.perform('Contact name changed in WhatsApp.', async sock => {
    if (!/^\d{5,20}(?::\d{1,5})?@(?:s\.whatsapp\.net|lid)$/.test(remoteJid)) throw new RequestError(400, 'An individual WhatsApp contact is required.');
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) throw new RequestError(400, 'Invalid contact name.');
    if (typeof sock.addOrEditContact !== 'function') throw new RequestError(501, 'Contact editing is unavailable in this WhatsApp provider.');
    const id = remoteJid.replace(/:\d+@/, '@'), fullName = name.trim();
    const existing = await this.repository!.getContactById(this.instance, id);
    const identifiers = [id, existing?.id, existing?.phoneNumber, existing?.lid];
    const pnJid = identifiers.find(value => value && /^\d{5,20}@s\.whatsapp\.net$/.test(value));
    const lidJid = identifiers.find(value => value && /^\d{5,20}@lid$/.test(value));
    if (this.sock !== sock) throw new RequestError(409, 'Instance connection changed during contact lookup.');
    // rc14 waits for the app-state IQ response and persists its version before
    // resolving. A rejected/uncertain provider operation must not become a local rename.
    await sock.addOrEditContact(id, { fullName, ...(pnJid ? { pnJid } : {}), ...(lidJid ? { lidJid } : {}), saveOnPrimaryAddressbook: true });
    const accepted: Contact = { id, name: fullName, savedName: fullName, savedNameUpdatedAt: new Date().toISOString(), nameSource: 'saved',
      ...(pnJid && pnJid !== id ? { phoneNumber: pnJid } : {}), ...(lidJid && lidJid !== id ? { lid: lidJid } : {}) };
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
    const contact = await this.repository!.getContactById(this.instance, remoteJid);
    if (contact) return contact;
    const results = await sock.onWhatsApp(remoteJid);
    const result = results?.find(entry => entry?.exists);
    if (!result) throw new RequestError(404, 'Contact not found on WhatsApp.');
    return { id: result.jid };
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
  presenceSubscribe(remoteJid: string) { return this.perform('Presence subscribed.', async sock => { await sock.presenceSubscribe(remoteJid); }); }
  profileName(name: string) { return this.perform('Profile name changed.', async sock => { await sock.updateProfileName(name); }); }
  profileStatus(status: string) { return this.perform('Profile status changed.', async sock => { await sock.updateProfileStatus(status); }); }
  updateProfilePicture(remoteJid: string, url: string) { return this.perform('Profile picture changed.', async sock => { await sock.updateProfilePicture(remoteJid, await downloadPublicMedia(url)); }); }
  removeProfilePicture(remoteJid: string) { return this.perform('Profile picture removed.', async sock => { await sock.removeProfilePicture(remoteJid); }); }
}
