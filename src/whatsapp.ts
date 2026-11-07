import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import NodeCache from '@cacheable/node-cache';
import type { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidNewsletter,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  toNumber,
  useMultiFileAuthState,
  type BaileysEventMap,
  type CacheStore,
  type GroupMetadata,
  type proto,
  type WAMessageKey,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import qrcode from 'qrcode-terminal';
import type { Messenger } from './bot.js';
import type { IncomingMessage } from './scores.js';

export const LOGGED_OUT_MARKER = 'LOGGED_OUT';

export interface WhatsAppOptions {
  authDir: string;
  phoneNumber?: string;
  groupJid?: string;
  dryRun: boolean;
  logger: Logger;
  baileysLogger: Logger;
  /** Cheap check on the raw text; everything else is dropped before we even look up the sender. */
  isRelevant: (text: string) => boolean;
  onGroupMessage: (msg: IncomingMessage) => Promise<void>;
  /** Current group members (without the bot itself), whenever the group metadata is (re)loaded. */
  onGroupMembers?: (members: Array<{ id: string; phoneJid?: string }>) => void;
  /** Called once, after the first successful connection. */
  onFirstOpen?: () => Promise<void>;
  /** WhatsApp unlinked this device. The auth state is useless now. */
  onLoggedOut: () => void;
}

const SEND_DELAY_MS: [number, number] = [1500, 4000];
const MAX_BACKOFF_MS = 60_000;
/** While not linked: retry pairing a few times quickly, then slowly (each try pings the phone). */
const UNLINKED_SLOW_RETRY_MS = 10 * 60_000;

export class WhatsAppClient implements Messenger {
  private sock?: WASocket;
  private connected = false;
  private stopped = false;
  private openedOnce = false;
  private attempt = 0;
  private groupMeta?: GroupMetadata;
  private openWaiters: Array<() => void> = [];
  /** Serialises message handling without blocking Baileys' event loop. */
  private queue: Promise<void> = Promise.resolve();
  private readonly log: Logger;
  private readonly retryCounter = new NodeCache({ stdTTL: 600, useClones: false }) as unknown as CacheStore;
  /** Our last few sent messages, so Baileys can re-send them if a recipient asks for a retry. */
  private readonly sent = new Map<string, proto.IMessage>();

  constructor(private readonly opts: WhatsAppOptions) {
    this.log = opts.logger;
  }

  async start(): Promise<void> {
    fs.mkdirSync(this.opts.authDir, { recursive: true, mode: 0o700 });
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // end(), not logout(): logout() would unlink the device.
    await this.sock?.end(undefined).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Messenger

  async send(text: string): Promise<void> {
    const jid = this.opts.groupJid;
    if (!jid) throw new Error('WA_GROUP_JID is not set');
    if (this.opts.dryRun) {
      process.stdout.write(`\n----- [dry-run] message to ${jid} -----\n${text}\n----------\n\n`);
      return;
    }
    await this.waitUntilOpen(10 * 60_000);
    const [min, max] = SEND_DELAY_MS;
    await sleep(min + Math.random() * (max - min));
    if (!this.sock || !this.connected) throw new Error('Not connected to WhatsApp');
    const msg = await this.sock.sendMessage(jid, { text });
    if (msg?.key.id && msg.message) {
      this.sent.set(msg.key.id, msg.message);
      if (this.sent.size > 20) this.sent.delete(this.sent.keys().next().value!);
    }
    this.log.info({ chars: text.length }, 'Message sent');
  }

  async memberIds(): Promise<Set<string> | null> {
    const meta = await this.getGroupMeta();
    if (!meta) return null;
    const ids = new Set<string>();
    for (const p of meta.participants) {
      for (const id of [p.id, p.lid, p.phoneNumber]) {
        if (id) ids.add(jidNormalizedUser(id));
      }
    }
    return ids;
  }

  // -------------------------------------------------------------------------
  // Connection

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir);
    if (state.creds.registered && !state.creds.account) {
      // A code was entered but WhatsApp never confirmed the link ("Couldn't link device"). Start over.
      this.log.warn('Previous linking attempt did not complete; starting a new one');
      state.creds.registered = false;
      await saveCreds();
    }
    const { version, isLatest } = await fetchLatestBaileysVersion();
    this.log.debug({ version: version.join('.'), isLatest }, 'Using WhatsApp Web version');

    const groupJid = this.opts.groupJid;
    const sock = makeWASocket({
      version,
      logger: this.opts.baileysLogger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.opts.baileysLogger),
      },
      // Behave like a quiet, mostly-offline user.
      markOnlineOnConnect: false,
      // No full history download. The small initial sync stays on (Baileys needs it for LID
      // mappings); we never listen to history events, so nothing old is processed or stored.
      syncFullHistory: false,
      // Status updates, broadcast lists and channels are dropped before decryption.
      shouldIgnoreJid: (jid) => Boolean(isJidBroadcast(jid) || isJidNewsletter(jid)),
      generateHighQualityLinkPreview: false,
      msgRetryCounterCache: this.retryCounter,
      cachedGroupMetadata: async (jid) => (jid === groupJid ? this.groupMeta : undefined),
      getMessage: async (key) => (key.id ? this.sent.get(key.id) : undefined),
    });
    this.sock = sock;

    let pairingRequested = false;
    let pairingFailed = false;

    sock.ev.process(async (events) => {
      if (events['creds.update']) await saveCreds();

      const update = events['connection.update'];
      if (update) {
        if (update.qr && !sock.authState.creds.account) {
          if (this.opts.phoneNumber && !pairingRequested) {
            pairingRequested = true;
            try {
              // Reuse the code from earlier attempts, so the code on screen stays valid across reconnects.
              const code = await sock.requestPairingCode(
                this.opts.phoneNumber,
                sock.authState.creds.pairingCode ?? undefined,
              );
              this.printPairingCode(code);
            } catch (err) {
              pairingFailed = true;
              this.log.error({ err: (err as Error).message }, 'Requesting a pairing code failed; falling back to QR');
            }
          }
          if (!this.opts.phoneNumber || pairingFailed) this.printQr(update.qr);
        }
        if (update.connection === 'open') this.onOpen(sock);
        if (update.connection === 'close') this.onClose(sock, update.lastDisconnect?.error as Boom | undefined);
      }

      if (events['messages.upsert']) this.onUpsert(sock, events['messages.upsert']);

      if (groupJid) {
        const touched =
          events['groups.update']?.some((g) => g.id === groupJid) ||
          events['groups.upsert']?.some((g) => g.id === groupJid) ||
          events['group-participants.update']?.id === groupJid;
        if (touched) this.refreshGroupMeta(sock);
      }
    });
  }

  private onOpen(sock: WASocket): void {
    this.connected = true;
    this.attempt = 0;
    this.log.info({ account: sock.user?.id }, 'Connected to WhatsApp');
    for (const resolve of this.openWaiters.splice(0)) resolve();

    void this.logGroups(sock)
      .then(async () => {
        if (!this.openedOnce) {
          this.openedOnce = true;
          await this.opts.onFirstOpen?.();
        }
      })
      .catch((err) => this.log.error({ err: (err as Error).message }, 'Post-connect tasks failed'));
  }

  private onClose(sock: WASocket, error: Boom | undefined): void {
    this.connected = false;
    if (this.sock === sock) this.sock = undefined;
    const code = error?.output?.statusCode;

    if (code === DisconnectReason.loggedOut) {
      fs.writeFileSync(path.join(this.opts.authDir, LOGGED_OUT_MARKER), `${new Date().toISOString()}\n`);
      this.log.fatal(
        'WhatsApp logged this device out (unlinked on the phone, or the phone was offline for ~14 days). ' +
          `Delete the contents of ${this.opts.authDir} and restart to link again.`,
      );
      this.opts.onLoggedOut();
      return;
    }
    if (this.stopped) return;

    let delay: number;
    if (code === DisconnectReason.restartRequired) {
      delay = 0; // normal right after linking
    } else if (code === DisconnectReason.connectionReplaced) {
      delay = 5 * 60_000;
      this.log.error('Another client took over this session (is the bot running twice?); retrying in 5 minutes');
    } else if (!sock.authState.creds.account) {
      // Not linked yet (QR linking never sets `registered`, so check for the account instead).
      // Each attempt lasts ~2.5 min, so the same code stays usable for ~25 min before slowing down.
      delay = this.attempt < 10 ? 5_000 : UNLINKED_SLOW_RETRY_MS;
      this.attempt += 1;
    } else {
      delay = Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** this.attempt);
      this.attempt += 1;
    }
    this.log.warn({ code, reason: error?.message, retryInS: Math.round(delay / 1000) }, 'Connection closed');
    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(delay: number): void {
    setTimeout(() => {
      if (this.stopped) return;
      this.connect().catch((err) => {
        this.log.error({ err: (err as Error).message }, 'Reconnect failed');
        this.attempt += 1;
        this.scheduleReconnect(Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** this.attempt));
      });
    }, delay);
  }

  private waitUntilOpen(timeoutMs: number): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for WhatsApp connection')), timeoutMs);
      this.openWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // Groups

  private async logGroups(sock: WASocket): Promise<void> {
    const groups = Object.values(await sock.groupFetchAllParticipating());
    this.log.info(`This account is in ${groups.length} group(s):`);
    for (const g of groups) {
      this.log.info({ jid: g.id, members: g.participants.length }, `  group "${g.subject}"`);
    }
    const target = this.opts.groupJid;
    if (!target) {
      this.log.warn('WA_GROUP_JID is not set. Copy the JID of your group from the list above into .env and restart.');
      return;
    }
    const meta = groups.find((g) => g.id === target);
    if (meta) {
      this.groupMeta = meta;
      this.reportMembers(sock, meta);
      this.log.info({ jid: target }, `Tracking group "${meta.subject}"`);
    } else {
      this.log.error({ jid: target }, 'WA_GROUP_JID is not one of the groups above; no messages will be processed');
    }
  }

  private async getGroupMeta(): Promise<GroupMetadata | undefined> {
    if (this.groupMeta) return this.groupMeta;
    if (!this.sock || !this.connected || !this.opts.groupJid) return undefined;
    this.groupMeta = await this.sock.groupMetadata(this.opts.groupJid);
    return this.groupMeta;
  }

  private refreshGroupMeta(sock: WASocket): void {
    const jid = this.opts.groupJid;
    if (!jid) return;
    sock
      .groupMetadata(jid)
      .then((meta) => {
        this.groupMeta = meta;
        this.reportMembers(sock, meta);
      })
      .catch((err) => this.log.warn({ err: (err as Error).message }, 'Could not refresh group metadata'));
  }

  private reportMembers(sock: WASocket, meta: GroupMetadata): void {
    const self = new Set(
      [sock.user?.id, sock.user?.lid].filter((j): j is string => Boolean(j)).map((j) => jidNormalizedUser(j)),
    );
    const members: Array<{ id: string; phoneJid?: string }> = [];
    for (const p of meta.participants) {
      const ids = [p.id, p.lid, p.phoneNumber]
        .filter((j): j is string => Boolean(j))
        .map((j) => jidNormalizedUser(j))
        .filter(Boolean);
      if (ids.some((j) => self.has(j))) continue;
      const lid = ids.find((j) => isLidUser(j));
      const pn = ids.find((j) => isPnUser(j));
      const id = lid ?? pn;
      if (id) members.push({ id, phoneJid: pn });
    }
    try {
      this.opts.onGroupMembers?.(members);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'Could not store group members');
    }
  }

  // -------------------------------------------------------------------------
  // Messages

  private onUpsert(sock: WASocket, upsert: BaileysEventMap['messages.upsert']): void {
    const groupJid = this.opts.groupJid;
    if (!groupJid) return;

    for (const m of upsert.messages) {
      // Everything outside the target group is ignored without being inspected.
      if (m.key.remoteJid !== groupJid || m.key.fromMe) continue;
      const content = normalizeMessageContent(m.message);
      if (!content || content.protocolMessage || content.reactionMessage) continue;
      const text =
        content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || undefined;
      if (!text || !this.opts.isRelevant(text)) continue;

      const key = m.key;
      const timestamp = toNumber(m.messageTimestamp);
      const pushName = m.pushName ?? undefined;
      this.queue = this.queue
        .then(async () => {
          const sender = await this.resolveSender(sock, key);
          if (!sender || !key.id) return;
          await this.opts.onGroupMessage({
            id: key.id,
            playerJid: sender.id,
            phoneJid: sender.phoneJid,
            pushName,
            text,
            timestamp: timestamp || Math.floor(Date.now() / 1000),
          });
        })
        .catch((err) => this.log.error({ err: (err as Error).message }, 'Failed to handle group message'));
    }
  }

  /**
   * Stable player id. Groups now address members by LID (`...@lid`, a privacy id); the phone
   * JID (`...@s.whatsapp.net`) is only sometimes known. Prefer the LID, fall back to the phone JID.
   */
  private async resolveSender(sock: WASocket, key: WAMessageKey): Promise<{ id: string; phoneJid?: string } | null> {
    const ids = [key.participant, key.participantAlt]
      .filter((j): j is string => Boolean(j))
      .map((j) => jidNormalizedUser(j))
      .filter(Boolean);
    let lid = ids.find((j) => isLidUser(j));
    let pn = ids.find((j) => isPnUser(j));
    try {
      const mapping = sock.signalRepository.lidMapping;
      if (!lid && pn) lid = jidNormalizedUser((await mapping.getLIDForPN(pn)) ?? undefined) || undefined;
      if (!pn && lid) pn = jidNormalizedUser((await mapping.getPNForLID(lid)) ?? undefined) || undefined;
    } catch (err) {
      this.log.debug({ err: (err as Error).message }, 'LID mapping lookup failed');
    }
    const id = lid ?? pn ?? ids[0];
    return id ? { id, phoneJid: pn } : null;
  }

  // -------------------------------------------------------------------------
  // Linking output

  private printPairingCode(code: string): void {
    const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    this.log.warn(`Pairing code for +${this.opts.phoneNumber}: ${pretty}`);
    process.stdout.write(
      [
        '',
        '==================================================================',
        `  WhatsApp pairing code:  ${pretty}`,
        '  On the bot phone: WhatsApp > Settings > Linked devices >',
        '  Link a device > "Link with phone number instead", enter the code.',
        '  (The code stays the same until linking succeeds.)',
        '==================================================================',
        '',
      ].join('\n') + '\n',
    );
  }

  private printQr(qr: string): void {
    this.log.warn('Scan this QR code with the bot phone: WhatsApp > Settings > Linked devices > Link a device');
    qrcode.generate(qr, { small: true });
  }
}
