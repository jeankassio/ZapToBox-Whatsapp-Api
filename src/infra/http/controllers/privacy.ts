import type { WAPrivacyGroupAddValue, WAPrivacyOnlineValue, WAPrivacyValue, WAReadReceiptsValue, WAPrivacyCallValue, WAPrivacyMessagesValue } from '@whiskeysockets/baileys';
import { SocketController } from './base.js';

export default class PrivacyController extends SocketController {
  unBlockUser(remoteJid: string, block: boolean) { return this.perform('Contact block status changed.', async sock => { await sock.updateBlockStatus(remoteJid, block ? 'block' : 'unblock'); }); }
  getPrivacySettings() { return this.perform('Privacy settings fetched.', async sock => ({ privacy: await sock.fetchPrivacySettings() })); }
  getBlockList() { return this.perform('Block list fetched.', async sock => ({ privacy: await sock.fetchBlocklist() })); }
  updateLastSeen(privacy: WAPrivacyValue) { return this.perform('Last seen privacy changed.', async sock => { await sock.updateLastSeenPrivacy(privacy); }); }
  updateOnline(privacy: WAPrivacyOnlineValue) { return this.perform('Online privacy changed.', async sock => { await sock.updateOnlinePrivacy(privacy); }); }
  profilePicture(privacy: WAPrivacyValue) { return this.perform('Profile picture privacy changed.', async sock => { await sock.updateProfilePicturePrivacy(privacy); }); }
  status(privacy: WAPrivacyValue) { return this.perform('Status privacy changed.', async sock => { await sock.updateStatusPrivacy(privacy); }); }
  markRead(privacy: WAReadReceiptsValue) { return this.perform('Read receipt privacy changed.', async sock => { await sock.updateReadReceiptsPrivacy(privacy); }); }
  addGroups(privacy: WAPrivacyGroupAddValue) { return this.perform('Group membership privacy changed.', async sock => { await sock.updateGroupsAddPrivacy(privacy); }); }
  ephemeral(time: number) { return this.perform('Default message expiration changed.', async sock => { await sock.updateDefaultDisappearingMode(time); }); }
  calls(privacy: WAPrivacyCallValue) { return this.perform('Call privacy changed.', async sock => { await sock.updateCallPrivacy(privacy); }); }
  messages(privacy: WAPrivacyMessagesValue) { return this.perform('Message privacy changed.', async sock => { await sock.updateMessagesPrivacy(privacy); }); }
  linkPreviews(disabled: boolean) { return this.perform('Link preview privacy changed.', async sock => { await sock.updateDisableLinkPreviewsPrivacy(disabled); }); }
}
