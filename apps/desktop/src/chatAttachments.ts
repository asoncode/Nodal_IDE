import { CHAT_ATTACHMENT_LIMITS, validateChatText, type ChatAttachmentInput } from '../../../packages/shared/src/chat.js';
export type DraftAttachment = { id: string; size: number; input: ChatAttachmentInput };
export function mentionAt(message: string, caret: number) {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(message.slice(0, caret));
  return match ? { start: caret - match[1].length - 1, caret, query: match[1] } : undefined;
}
export function checkAttachments(items: DraftAttachment[]) {
  if (items.length > CHAT_ATTACHMENT_LIMITS.count) throw new Error('Attach at most 8 files per message.');
  if (items.reduce((bytes, item) => bytes + item.size, 0) > CHAT_ATTACHMENT_LIMITS.totalBytes) throw new Error('Attachments must total at most 256 KiB per message.');
}
export async function readChatUpload(file: File): Promise<DraftAttachment> {
  if (file.size > CHAT_ATTACHMENT_LIMITS.fileBytes) throw new Error(`${file.name}: attachments must be at most 64 KiB each.`);
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}. Please try again.`));
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(file);
  });
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`${file.name}: attach a UTF-8 code or text file.`); }
  const size = validateChatText(file.name, content);
  return { id: crypto.randomUUID(), size, input: { kind: 'upload', name: file.name, content } };
}
