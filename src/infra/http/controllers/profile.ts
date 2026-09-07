import { SocketController, RequestError, type ControllerDependencies } from './base.js';
import { downloadPublicMedia } from './remote-media.js';

export default class ProfileController extends SocketController {
  onWhatsapp(remoteJid: string) { return this.perform('Contact lookup completed.', async sock => {
    const contact = await this.repository!.getContactById(this.instance, remoteJid);
    if (contact) return contact;
    const results = await sock.onWhatsApp(remoteJid);
    const result = results?.find(entry => entry?.exists);
    if (!result) throw new RequestError(404, 'Contact not found on WhatsApp.');
    return { id: result.jid };
  }); }
  fetchStatus(remoteJid: string) { return this.perform('Status fetched.', async sock => ({ status: await sock.fetchStatus(remoteJid) })); }
  fetchProfilePicture(remoteJid: string) { return this.perform('Profile picture fetched.', async sock => { const status = await sock.profilePictureUrl(remoteJid, 'image'); return { status: status ?? null }; }); }
  fetchBusinessProfile(remoteJid: string) { return this.perform('Business profile fetched.', async sock => ({ profile: await sock.getBusinessProfile(remoteJid) })); }
  presenceSubscribe(remoteJid: string) { return this.perform('Presence subscribed.', async sock => { await sock.presenceSubscribe(remoteJid); }); }
  profileName(name: string) { return this.perform('Profile name changed.', async sock => { await sock.updateProfileName(name); }); }
  profileStatus(status: string) { return this.perform('Profile status changed.', async sock => { await sock.updateProfileStatus(status); }); }
  updateProfilePicture(remoteJid: string, url: string) { return this.perform('Profile picture changed.', async sock => { await sock.updateProfilePicture(remoteJid, await downloadPublicMedia(url)); }); }
  removeProfilePicture(remoteJid: string) { return this.perform('Profile picture removed.', async sock => { await sock.removeProfilePicture(remoteJid); }); }
}
