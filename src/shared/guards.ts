import { 
    AudioMessage, 
    ContactMessage, 
    DocumentMessage, 
    ForwardMessage, 
    GifMessage, 
    ImageMessage, 
    LocationMessage, 
    PinMessage, 
    PollMessage, 
    ReactionMessage, 
    StickerMessage, 
    TextMessage, 
    VideoMessage } from "./types";

function isObject(v: any) {
  return typeof v === "object" && v !== null;
}

function isString(v: any) {
  return typeof v === "string";
}

function isNumber(v: any) {
  return typeof v === "number" && !isNaN(v);
}

function isBoolean(v: any) {
  return typeof v === "boolean";
}

export function isForwardMessage(obj: any): obj is ForwardMessage {
  return isObject(obj) && isString(obj.forward);
}

export function isTextMessage(obj: any): obj is TextMessage {
  return (
    isObject(obj) &&
    isString(obj.text) &&
    (
      obj.mentions === undefined ||
      (Array.isArray(obj.mentions) && obj.mentions.every(isString))
    )
  );
}

export function isLocationMessage(obj: any): obj is LocationMessage {
  return (
    isObject(obj) &&
    isObject(obj.location) &&
    isNumber(obj.location.degreesLatitude) &&
    isNumber(obj.location.degreesLongitude)
  );
}

export function isContactMessage(obj: any): obj is ContactMessage {
  return (
    isObject(obj) &&
    isString(obj.displayName) &&
    isNumber(obj.waid) &&
    isString(obj.phoneNumber)
  );
}

export function isReactionMessage(obj: any): obj is ReactionMessage {
  return (
    isObject(obj) &&
    isString(obj.emoji) &&
    isString(obj.messageId)
  );
}

export function isPinMessage(obj: any): obj is PinMessage {
  return (
    isObject(obj) &&
    isObject(obj.pin) &&
    isNumber(obj.pin.type) &&
    isNumber(obj.pin.time) &&
    isObject(obj.pin.key)
  );
}

export function isPollMessage(obj: any): obj is PollMessage {
  return (
    isObject(obj) &&
    isObject(obj.poll) &&
    isString(obj.poll.name) &&
    Array.isArray(obj.poll.values) &&
    obj.poll.values.every(isString) &&
    isNumber(obj.poll.selectableCount) &&
    isBoolean(obj.poll.toAnnouncementGroup)
  );
}

export function isImageMessage(obj: any): obj is ImageMessage {
  return (
    isObject(obj) &&
    isObject(obj.image) &&
    isString(obj.image.url) &&
    (obj.caption === undefined || isString(obj.caption)) &&
    (obj.viewOnce === undefined || isBoolean(obj.viewOnce))
  );
}

export function isVideoMessage(obj: any): obj is VideoMessage {
  return (
    isObject(obj) &&
    isObject(obj.video) &&
    isString(obj.video.url) &&
    (obj.caption === undefined || isString(obj.caption)) &&
    (obj.ptv === undefined || isBoolean(obj.ptv)) &&
    (obj.viewOnce === undefined || isBoolean(obj.viewOnce))
  );
}

export function isGifMessage(obj: any): obj is GifMessage {
  return (
    isObject(obj) &&
    isObject(obj.video) &&
    isString(obj.video.url) &&
    (obj.caption === undefined || isString(obj.caption)) &&
    (obj.ptv === undefined || isBoolean(obj.ptv)) &&
    (obj.viewOnce === undefined || isBoolean(obj.viewOnce)) &&
    isBoolean(obj.gifPlayback)
  );
}

export function isAudioMessage(obj: any): obj is AudioMessage {
  return (
    isObject(obj) &&
    isObject(obj.audio) &&
    isString(obj.audio.url) &&
    isString(obj.mimetype) &&
    (obj.viewOnce === undefined || isBoolean(obj.viewOnce))
  );
}

export function isDocumentMessage(obj: any): obj is DocumentMessage{
  return (
    isObject(obj) &&
    isObject(obj.document) &&
    isString(obj.document.url) &&
    isString(obj.mimetype) &&
    isString(obj.fileName)
  );
}

export function isStickerMessage(obj: any): obj is StickerMessage{
  return (
    isObject(obj) &&
    isObject(obj.sticker) &&
    isString(obj.sticker.url)
  );
}
