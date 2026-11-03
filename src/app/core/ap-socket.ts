import { candidateUrls } from './ap-url';
import type { ClientPacket, ServerPacket } from '../protocol/types';
import { decideRetry } from './retry-policy';

export type SocketState =
  | 'idle'
  | 'connecting'
  | 'handshake'
  | 'online'
  | 'backoff'
  | 'unreachable'
  | 'fatal';

export interface ApSocketHandlers {
  onState: (state: SocketState, detail?: string) => void;
  onPackets: (packets: ServerPacket[]) => void;
  onOpen: () => void;
}

export interface ApSocketTarget {
  host: string;
  port: number;
}

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
const BACKOFF_FACTOR = 1.7;
const BACKOFF_RESET_MS = 60_000;
const KEEPALIVE_INTERVAL_MS = 30_000;
const KEEPALIVE_MAX_MISSES = 3;

export class ApSocket {
  private ws: WebSocket | null = null;
  private target: ApSocketTarget | null = null;
  private attempt = 0;
  private schemeIndex = 0;
  private openedAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveMisses = 0;
  private stopped = true;
  private opens = 0;
  private everOnline = false;
  private openUrl: string | null = null;

  /** Faux par defaut, sinon l'ecran reste bloque sur une tentative que rien n'interrompt. */
  autoRetry = false;

  /** Necessaire pour s'auto-adresser un Bounce. */
  ownSlot: number | null = null;

  state: SocketState = 'idle';

  /** Le schema qui a abouti : `ws://` ou `wss://`, selon le serveur. */
  get url(): string | null {
    return this.openUrl;
  }

  constructor(private readonly handlers: ApSocketHandlers) {}

  connect(target: ApSocketTarget): void {
    this.disconnect('user');
    this.target = target;
    this.stopped = false;
    this.attempt = 0;
    this.schemeIndex = 0;
    this.opens = 0;
    this.openedAt = 0;
    this.everOnline = false;
    this.openUrl = null;
    this.open();
  }

  disconnect(_reason: 'user' | 'fatal' = 'user'): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      try {
        this.ws.close();
      } catch {
        /* deja ferme */
      }
      this.ws = null;
    }
    this.setState('idle');
  }

  fail(detail: string): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.setState('fatal', detail);
  }

  send(packets: ClientPacket[]): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(packets));
  }

  markHandshakeDone(): void {
    this.everOnline = true;
    this.setState('online');
    this.startKeepalive();
  }

  private open(): void {
    if (this.stopped || !this.target) return;
    const urls = candidateUrls(this.target.host, this.target.port);
    const url = urls[this.schemeIndex % urls.length];
    this.opens++;
    this.setState('connecting', url);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.scheduleRetry(String(e));
      return;
    }
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.openUrl = url;
      this.openedAt = Date.now();
      this.keepaliveMisses = 0;
      this.setState('handshake', url);
      this.handlers.onOpen();
    };

    ws.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      const packets = (Array.isArray(parsed) ? parsed : [parsed]) as ServerPacket[];
      for (const p of packets) {
        if (p?.cmd === 'Bounced') this.keepaliveMisses = 0;
      }
      this.handlers.onPackets(packets);
    };

    ws.onerror = () => {
      /* onclose suit toujours. */
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopKeepalive();
      if (this.stopped) return;
      // Une socket jamais ouverte a un `openedAt` d'une connexion precedente.
      if (!opened || Date.now() - this.openedAt < 1000) this.schemeIndex++;
      this.scheduleRetry('connexion fermee');
    };
  }

  private scheduleRetry(detail: string): void {
    if (this.stopped) return;

    const decision = decideRetry({
      everOnline: this.everOnline,
      autoRetry: this.autoRetry,
      attempts: this.opens,
      candidates: this.target ? candidateUrls(this.target.host, this.target.port).length : 1,
    });
    if (decision === 'unreachable') {
      this.stopped = true;
      this.clearTimers();
      this.setState('unreachable', detail);
      return;
    }

    if (this.openedAt && Date.now() - this.openedAt > BACKOFF_RESET_MS) this.attempt = 0;
    const raw = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(BACKOFF_FACTOR, this.attempt));
    const delay = Math.round(raw * (0.75 + Math.random() * 0.5));
    this.attempt++;
    this.setState('backoff', `${detail} — nouvelle tentative dans ${Math.round(delay / 1000)} s`);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  /** Pas de ping WebSocket en navigateur : sans Bounce, une room muette ressemble a une socket morte. */
  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      if (this.keepaliveMisses >= KEEPALIVE_MAX_MISSES) {
        this.ws.close();
        return;
      }
      this.keepaliveMisses++;
      this.send([
        {
          cmd: 'Bounce',
          slots: this.ownSlot === null ? [] : [this.ownSlot],
          data: { vigipelago: 'keepalive' },
        },
      ]);
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopKeepalive();
  }

  private setState(state: SocketState, detail?: string): void {
    this.state = state;
    this.handlers.onState(state, detail);
  }
}
