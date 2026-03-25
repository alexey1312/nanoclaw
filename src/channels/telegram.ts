import fs from 'fs';
import https from 'https';
import path from 'path';
import { Api, Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { downloadTelegramFile, transcribeVoice } from '../telegram-media.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Convert Claude's Markdown output to Telegram HTML.
 * Telegram HTML supports: <b>, <i>, <code>, <pre>, <a>, <blockquote>
 * This is more reliable than Markdown v1/v2 which break on mixed formatting.
 */
function markdownToTelegramHtml(text: string): string {
  let result = text;

  // Remove horizontal rules (--- or ***)
  result = result.replace(/^[-*_]{3,}\s*$/gm, '');

  // Convert markdown tables to plain text
  result = result.replace(/^\|[\s:]*[-]+[\s:]*(\|[\s:]*[-]+[\s:]*)+\|?\s*$/gm, '');
  result = result.replace(/^\|(.+)\|?\s*$/gm, (_m, row) => {
    const cells = row
      .split('|')
      .map((c: string) => c.trim())
      .filter((c: string) => c);
    return cells.join(' — ');
  });

  // Remove image syntax ![alt](url) — keep alt + url
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) =>
    alt ? `${alt}: ${url}` : url,
  );

  // Escape HTML entities (must happen before we add HTML tags)
  result = result.replace(/&/g, '&amp;');
  result = result.replace(/</g, '&lt;');
  result = result.replace(/>/g, '&gt;');

  // Convert blockquotes (after escaping > → &gt;)
  result = result.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
  // Merge consecutive blockquotes
  result = result.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  // Code blocks: ```lang\ncode\n``` → <pre>code</pre>
  result = result.replace(/```\w*\n([\s\S]*?)```/g, '<pre>$1</pre>');

  // Inline code: `code` → <code>code</code>
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers: ## text → <b>text</b>
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (but not inside words like file_name)
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>');

  // Links: [text](url) → <a href="url">text</a>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Remove excessive blank lines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

/**
 * Split text into chunks at paragraph boundaries, respecting Telegram's 4096 char limit.
 * Prefers splitting at double-newlines, then single newlines, then by length.
 */
function splitMessage(text: string, maxLength = 4096): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at paragraph boundary (double newline)
    let splitIdx = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIdx < maxLength * 0.3) {
      // Too far back — try single newline
      splitIdx = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitIdx < maxLength * 0.3) {
      // Still too far back — split at space
      splitIdx = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIdx < maxLength * 0.3) {
      // Last resort — hard cut
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

/**
 * Send a message with Telegram HTML parse mode, falling back to plain text.
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  const sanitized = markdownToTelegramHtml(text);

  try {
    await api.sendMessage(chatId, sanitized, {
      ...options,
      parse_mode: 'HTML',
    });
  } catch (err: any) {
    const isThreadError =
      err?.error_code === 400 &&
      typeof err?.description === 'string' &&
      err.description.includes('thread not found');

    if (isThreadError && options.message_thread_id) {
      logger.debug({ chatId }, 'Thread not found, sending without thread_id');
      const { message_thread_id: _, ...rest } = options;
      return sendTelegramMessage(api, chatId, text, rest);
    }

    // Fallback: send as plain text if HTML parsing fails
    logger.debug({ err }, 'HTML send failed, falling back to plain text');
    // Strip HTML tags for plain text fallback
    const plain = sanitized.replace(/<[^>]+>/g, '');
    await api.sendMessage(chatId, plain, options);
  }
}

// File extensions that should be sent as photos (with inline preview)
const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

// Pattern to detect file send directives in outgoing messages
const FILE_PATTERN = /\[send_file:([^\]]+)\]/g;

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  // Track the last message_thread_id per chat for topic/thread support
  private threadMap = new Map<string, number>();
  // Track the last inbound message ID per chat for reaction updates
  private lastInboundMsg = new Map<string, { chatId: number; messageId: number }>();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', async (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      const text = `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`;
      await sendTelegramMessage(this.bot!.api, chatId, text);
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();

      // Track thread/topic ID for replies
      if (ctx.message.message_thread_id) {
        this.threadMap.set(chatJid, ctx.message.message_thread_id);
      }

      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Ack reaction — show 👀 so the user knows the bot received the message
      this.ackReaction(ctx.chat.id, ctx.message.message_id);
      this.lastInboundMsg.set(chatJid, {
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
      });

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // --- Media handlers: download files and deliver with workspace paths ---

    const deliverMedia = (ctx: any, chatJid: string, content: string) => {
      if (ctx.message?.message_thread_id) {
        this.threadMap.set(chatJid, ctx.message.message_thread_id);
      }
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    const getGroupFolder = (chatJid: string): string | null => {
      const group = this.opts.registeredGroups()[chatJid];
      return group ? group.folder : null;
    };

    const saveFile = async (
      chatJid: string,
      fileId: string,
      fileName: string,
    ): Promise<{ hostPath: string; agentPath: string } | null> => {
      const folder = getGroupFolder(chatJid);
      if (!folder) return null;
      const attachDir = path.join(GROUPS_DIR, folder, 'attachments');
      const destPath = path.join(attachDir, fileName);
      try {
        await downloadTelegramFile(this.botToken, fileId, destPath);
        return {
          hostPath: destPath,
          agentPath: `/workspace/group/attachments/${fileName}`,
        };
      } catch (err) {
        logger.error({ err, fileId, fileName }, 'Telegram file download failed');
        return null;
      }
    };

    // Photos
    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const msgId = ctx.message.message_id;
      const fileName = `photo_${msgId}.jpg`;

      const saved = await saveFile(chatJid, largest.file_id, fileName);
      if (saved) {
        deliverMedia(
          ctx,
          chatJid,
          `[Photo saved: ${saved.agentPath}]${caption}`,
        );
        logger.info({ chatJid, path: saved.agentPath }, 'Telegram photo saved');
      } else {
        deliverMedia(ctx, chatJid, `[Photo — download failed]${caption}`);
      }
    });

    // Voice messages
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const msgId = ctx.message.message_id;
      const fileName = `voice_${msgId}.ogg`;

      const saved = await saveFile(chatJid, ctx.message.voice.file_id, fileName);
      if (!saved) {
        deliverMedia(ctx, chatJid, '[Voice message — download failed]');
        return;
      }

      // Transcribe if OPENAI_API_KEY is available
      const openaiKey =
        process.env.OPENAI_API_KEY ||
        readEnvFile(['OPENAI_API_KEY']).OPENAI_API_KEY ||
        '';
      if (openaiKey) {
        const transcript = await transcribeVoice(saved.hostPath, openaiKey);
        if (transcript) {
          deliverMedia(
            ctx,
            chatJid,
            `[Voice message transcription]: ${transcript}`,
          );
          logger.info({ chatJid }, 'Voice message transcribed');
          return;
        }
      }

      deliverMedia(
        ctx,
        chatJid,
        `[Voice message saved: ${saved.agentPath}]`,
      );
    });

    // Audio files
    this.bot.on('message:audio', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const msgId = ctx.message.message_id;
      const audioName =
        ctx.message.audio.file_name || `audio_${msgId}.mp3`;

      const saved = await saveFile(chatJid, ctx.message.audio.file_id, audioName);
      if (saved) {
        deliverMedia(
          ctx,
          chatJid,
          `[Audio saved: ${saved.agentPath}]`,
        );
      } else {
        deliverMedia(ctx, chatJid, `[Audio: ${audioName} — download failed]`);
      }
    });

    // Documents (PDF, files, etc.)
    this.bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const docName =
        ctx.message.document?.file_name || `file_${ctx.message.message_id}`;

      const saved = await saveFile(
        chatJid,
        ctx.message.document!.file_id,
        docName,
      );
      if (saved) {
        deliverMedia(
          ctx,
          chatJid,
          `[Document saved: ${saved.agentPath}]${caption}`,
        );
        logger.info(
          { chatJid, path: saved.agentPath, name: docName },
          'Telegram document saved',
        );
      } else {
        deliverMedia(
          ctx,
          chatJid,
          `[Document: ${docName} — download failed]${caption}`,
        );
      }
    });

    // Video
    this.bot.on('message:video', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const msgId = ctx.message.message_id;
      const fileName =
        ctx.message.video.file_name || `video_${msgId}.mp4`;

      const saved = await saveFile(chatJid, ctx.message.video.file_id, fileName);
      if (saved) {
        deliverMedia(
          ctx,
          chatJid,
          `[Video saved: ${saved.agentPath}]${caption}`,
        );
      } else {
        deliverMedia(ctx, chatJid, `[Video — download failed]${caption}`);
      }
    });

    // Video notes (round video messages)
    this.bot.on('message:video_note', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const msgId = ctx.message.message_id;
      const fileName = `videonote_${msgId}.mp4`;

      const saved = await saveFile(
        chatJid,
        ctx.message.video_note.file_id,
        fileName,
      );
      if (saved) {
        deliverMedia(
          ctx,
          chatJid,
          `[Video note saved: ${saved.agentPath}]`,
        );
      } else {
        deliverMedia(ctx, chatJid, '[Video note — download failed]');
      }
    });

    // Stickers, location, contact — keep as text placeholders
    this.bot.on('message:sticker', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const emoji = ctx.message.sticker?.emoji || '';
      deliverMedia(ctx, chatJid, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const loc = ctx.message.location;
      deliverMedia(
        ctx,
        chatJid,
        `[Location: ${loc.latitude}, ${loc.longitude}]`,
      );
    });
    this.bot.on('message:contact', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const c = ctx.message.contact;
      deliverMedia(
        ctx,
        chatJid,
        `[Contact: ${c.first_name} ${c.last_name || ''} ${c.phone_number}]`,
      );
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const threadId = this.threadMap.get(jid);
      const threadOpts = threadId ? { message_thread_id: threadId } : {};

      // Extract and send any file directives ([send_file:/path/to/file])
      const files: string[] = [];
      const cleanText = text.replace(FILE_PATTERN, (_match, filePath) => {
        files.push(filePath.trim());
        return '';
      }).trim();

      // Send text as new message(s)
      if (cleanText) {
        const chunks = splitMessage(cleanText);
        for (const chunk of chunks) {
          await this.sendAndTrack(numericId, chunk, threadOpts);
        }
      }

      // Send files
      for (const filePath of files) {
        await this.sendFile(numericId, filePath, threadOpts);
      }

      // Update ack reaction from 👀 to 👍 on first response
      const inbound = this.lastInboundMsg.get(jid);
      if (inbound) {
        this.lastInboundMsg.delete(jid);
        this.doneReaction(inbound.chatId, inbound.messageId);
      }

      logger.info({ jid, length: text.length, files: files.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  private async sendAndTrack(
    chatId: string,
    text: string,
    opts: { message_thread_id?: number } = {},
  ): Promise<number | undefined> {
    if (!this.bot) return undefined;
    const html = markdownToTelegramHtml(text);
    try {
      const msg = await this.bot.api.sendMessage(chatId, html, {
        ...opts,
        parse_mode: 'HTML',
      });
      return msg.message_id;
    } catch {
      // HTML failed — strip tags and send as plain text
      const plain = html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      try {
        const msg = await this.bot.api.sendMessage(chatId, plain, opts);
        return msg.message_id;
      } catch (err) {
        logger.error({ chatId, err }, 'Failed to send tracked message');
        return undefined;
      }
    }
  }

  private async sendFile(
    chatId: string,
    filePath: string,
    opts: { message_thread_id?: number } = {},
  ): Promise<void> {
    if (!this.bot) return;

    // Resolve container path → host path
    const hostPath = filePath.startsWith('/workspace/group/')
      ? filePath // Already a host-resolvable path from group workspace
      : filePath;

    // Check if file exists by looking in group directories
    const possiblePaths = [
      hostPath,
      // If it's a container path, try resolving through groups dir
      ...Object.values(this.opts.registeredGroups()).map((g) =>
        path.join(GROUPS_DIR, g.folder, filePath.replace(/^\/workspace\/group\//, '')),
      ),
    ];

    let resolvedPath: string | null = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        resolvedPath = p;
        break;
      }
    }

    if (!resolvedPath) {
      logger.warn({ filePath }, 'File not found for Telegram send');
      return;
    }

    try {
      const ext = path.extname(resolvedPath).toLowerCase();
      const inputFile = new InputFile(resolvedPath);
      const fileName = path.basename(resolvedPath);

      if (PHOTO_EXTENSIONS.has(ext)) {
        await this.bot.api.sendPhoto(chatId, inputFile, opts);
      } else {
        await this.bot.api.sendDocument(chatId, inputFile, {
          ...opts,
          caption: fileName,
        });
      }
      logger.info({ chatId, file: resolvedPath }, 'Telegram file sent');
    } catch (err) {
      logger.error({ chatId, filePath: resolvedPath, err }, 'Failed to send Telegram file');
    }
  }

  private async ackReaction(
    chatId: number,
    messageId: number,
  ): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.setMessageReaction(chatId, messageId, [
        { type: 'emoji', emoji: '👀' },
      ]);
    } catch (err) {
      // Reactions may not be supported in all chat types — silently ignore
      logger.debug({ chatId, err }, 'Failed to set ack reaction');
    }
  }

  private async doneReaction(
    chatId: number,
    messageId: number,
  ): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.setMessageReaction(chatId, messageId, [
        { type: 'emoji', emoji: '👍' },
      ]);
    } catch (err) {
      logger.debug({ chatId, err }, 'Failed to set done reaction');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;

    const numericId = jid.replace(/^tg:/, '');
    const threadId = this.threadMap.get(jid);
    const threadOpts = threadId ? { message_thread_id: threadId } : {};

    try {
      await this.bot.api.sendChatAction(numericId, 'typing', threadOpts);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
