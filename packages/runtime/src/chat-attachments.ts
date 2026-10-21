import { basename } from 'node:path';
import { readFile, isSensitivePath } from '../../workspace/src/index.js';
import { CHAT_ATTACHMENT_LIMITS, validateChatText, type ChatAttachmentInput, type ChatAttachment } from '../../shared/src/chat.js';

/** Capture context once at send time. Uploaded text is never written into the repository. */
export async function prepareChatAttachments(root: string, inputs: ChatAttachmentInput[]): Promise<ChatAttachment[]> {
  if (inputs.length > CHAT_ATTACHMENT_LIMITS.count) throw new Error('Attach at most 8 files per message.');
  const attachments: ChatAttachment[] = []; let bytes = 0;
  for (const input of inputs) {
    let attachment: ChatAttachment;
    if (input.kind === 'reference') {
      if (isSensitivePath(input.path)) throw new Error('Credential-like files cannot be attached.');
      const file = await readFile(root, input.path);
      attachment = { kind: 'reference', path: input.path, name: basename(input.path), content: file.content };
    } else {
      if (!input.name || input.name.length > 255 || /[\\/\0\r\n]/.test(input.name)) throw new Error('Upload needs a plain filename.');
      if (isSensitivePath(input.name)) throw new Error('Credential-like files cannot be attached.');
      attachment = { ...input };
    }
    bytes += validateChatText(attachment.name, attachment.content);
    if (bytes > CHAT_ATTACHMENT_LIMITS.totalBytes) throw new Error('Attachments must total at most 256 KiB per message.');
    attachments.push(attachment);
  }
  return attachments;
}
