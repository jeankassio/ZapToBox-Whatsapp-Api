import type { Contact } from '@whiskeysockets/baileys';

export class ContactMapper {
  static toContact(row: { jid?: string | null; lid?: string | null; name?: string | null }): Contact {
    const pn = row.jid?.endsWith('@s.whatsapp.net') ? row.jid : undefined;
    const lid = row.lid || (row.jid?.endsWith('@lid') ? row.jid : undefined);
    const id = lid || pn || row.jid;
    if (!id) throw new Error('Contact has no WhatsApp identifier');
    return { id, ...(pn && id !== pn ? { phoneNumber: pn } : {}), ...(lid && id !== lid ? { lid } : {}), ...(row.name ? { name: row.name } : {}) };
  }
}
