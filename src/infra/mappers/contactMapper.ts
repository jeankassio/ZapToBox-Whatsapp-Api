import { Contact } from "@whiskeysockets/baileys";

export class ContactMapper {

    static toContact(numId: any): Contact {
        
        return {
            id: numId.jid,
            lid: numId.lid,
            phoneNumber: numId.jid.replace("@s.whatsapp.net", ""),
            name: numId.name
        };
    }

}
