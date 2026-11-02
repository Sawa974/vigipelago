import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApSessionService } from './core/ap-session.service';
import { Dashboard } from './ui/dashboard';
import { PlayersTab } from './ui/players';
import { ConsoleTab } from './ui/console-tab';
import { Dialog } from './ui/dialog';
import { ThemeDialog } from './ui/theme-dialog';
import { LanguageDialog } from './ui/language-dialog';
import { download } from './core/download';
import { ArchiveService } from './io/archive.service';
import { DuplicateTargetError, ProfileService } from './core/profile.service';
import { ConnectScreen, type ConnectRequest } from './ui/connect-screen';
import { labelOf } from './core/profiles';
import { durationLabel } from './core/duration';
import { offlineMessage } from './core/offline-message';
import { db, type ConnectionProfile, type Room } from './db/db';
import { mergeCoverage } from './ingest/coverage';
import { permissionRule } from './protocol/permissions';
import { I18n } from './i18n/i18n.service';
import type { Key } from './i18n/en';
import { CLIENT_STATUS } from './ingest/client-status';
import type { ArchiveMode, ArchiveSummary } from './io/ndjson';
import type { ImportReport } from './io/archive.service';

interface PartyInfo {
  room: Room;
  games: number;
  sessions: number;
  coveredMs: number;
  goals: Set<number>;
}

const IDLE_STATES = new Set(['idle', 'fatal', 'unreachable']);

const TABS = [
  { key: 'console', label: 'tabs.console' },
  { key: 'players', label: 'tabs.players' },
  { key: 'stats', label: 'tabs.stats' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

const STATE_LABELS: Record<string, Key> = {
  idle: 'state.idle',
  connecting: 'state.connecting',
  handshake: 'state.handshake',
  online: 'state.online',
  backoff: 'state.backoff',
  unreachable: 'state.unreachable',
  fatal: 'state.fatal',
};

@Component({
  selector: 'app-root',
  imports: [FormsModule, Dashboard, PlayersTab, ConnectScreen, ConsoleTab, Dialog, ThemeDialog, LanguageDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.css',
  host: {
    '(document:click)': 'closeMenu($event)',
    '(document:keydown.escape)': 'menuOpen.set(false)',
  },
})
export class App {
  protected readonly ap = inject(ApSessionService);
  private readonly archive = inject(ArchiveService);
  protected readonly profiles = inject(ProfileService);
  private readonly i18n = inject(I18n);
  protected readonly t = this.i18n.t;

  private readonly activeProfileId = signal<number | null>(null);
  protected readonly tabs = TABS;
  protected readonly tab = signal<TabKey>('console');
  protected readonly menuOpen = signal(false);
  protected readonly dialog = signal<'export' | 'import' | 'info' | 'theme' | 'language' | null>(null);
  protected readonly info = signal<PartyInfo | null>(null);
  /** Sans lui, « pas encore enregistree » clignoterait pendant la lecture. */
  protected readonly infoReady = signal(false);
  protected readonly dragOver = signal(false);
  protected readonly exportMode = signal<ArchiveMode>('full');
  protected readonly archiveBusy = signal(false);
  protected readonly archiveNote = signal<string | null>(null);
  protected readonly fileSummary = signal<ArchiveSummary | null>(null);
  protected readonly fileReasons = signal<string[]>([]);
  protected readonly fileName = signal<string | null>(null);
  protected readonly importReport = signal<ImportReport | null>(null);
  protected readonly addedProfiles = signal<ConnectionProfile[]>([]);
  protected readonly slotDraft = signal<Record<number, string>>({});
  protected readonly slotNote = signal<string | null>(null);
  private pendingText: string | null = null;

  protected readonly stateLabel = computed(() => {
    const key = STATE_LABELS[this.ap.state()];
    return key ? this.t(key) : this.ap.state();
  });
  private readonly targetRoomId = computed(() => {
    const id = this.activeProfileId();
    return this.profiles.profiles().find((p) => p.id === id)?.roomId ?? null;
  });

  /** Meme calcul que `ConsoleTab.offline` : `roomId`, pas `localRoomId` que la connexion efface. */
  protected readonly offline = computed(
    () => this.ap.roomId() !== null && IDLE_STATES.has(this.ap.state()),
  );

  protected readonly connectError = computed(() => {
    if (this.ap.state() === 'unreachable' || this.ap.refusal().length) {
      // Jamais `ap.detail()` : il porte l'URL, et l'ecran peut etre en stream.
      const why = this.t(offlineMessage(this.ap.state(), this.ap.refusal()));
      return `${why} ${this.t('home.noLocalData')}`;
    }
    return this.ap.lastError() || null;
  });

  protected readonly durationLabel = durationLabel;

  protected datetime(ts: number): string {
    return this.i18n.datetime(ts);
  }

  protected openMenuItem(item: 'export' | 'import' | 'info' | 'theme' | 'language'): void {
    this.menuOpen.set(false);
    if (item === 'info') void this.loadInfo();
    this.dialog.set(item);
  }

  /** La base et non la memoire : hors connexion, c'est la seule source. */
  private async loadInfo(): Promise<void> {
    this.infoReady.set(false);
    const roomId = this.ap.roomId();
    if (roomId === null) {
      this.info.set(null);
      this.infoReady.set(true);
      return;
    }
    const [room, sessions, stats] = await Promise.all([
      db.rooms.get(roomId),
      db.sessions.where('roomId').equals(roomId).toArray(),
      db.slotStats.where('roomId').equals(roomId).toArray(),
    ]);
    this.infoReady.set(true);
    if (!room) {
      this.info.set(null);
      return;
    }
    this.info.set({
      room,
      games: new Set(room.players.map((p) => p.game).filter(Boolean)).size,
      sessions: sessions.length,
      coveredMs: mergeCoverage(sessions, Date.now()).reduce((sum, i) => sum + (i.to - i.from), 0),
      goals: new Set(stats.filter((s) => s.status === CLIENT_STATUS.goal).map((s) => s.slot)),
    });
  }

  protected permission(room: Room, key: string): string {
    const rule = permissionRule(room.permissions?.[key]);
    return rule === null ? this.t('common.unknown') : this.t(`perm.${rule}`);
  }

  /** Une valeur absente est inconnue, jamais un « non ». */
  protected yesNo(v: boolean | null | undefined, yes: Key, no: Key): string {
    if (v === null || v === undefined) return this.t('common.unknown');
    return this.t(v ? yes : no);
  }

  protected closeMenu(e: MouseEvent): void {
    if (!this.menuOpen()) return;
    if ((e.target as Element | null)?.closest('.menu-wrap')) return;
    this.menuOpen.set(false);
  }

  protected sweepNow(): void {
    void this.ap.sweepNow();
  }

  /** Sur `roomId`, que seul `forgetRoom` remet a `null` : pas `localRoomId`, que la connexion efface. */
  protected readonly showConnect = computed(() => {
    if (this.ap.roomId() !== null) return false;
    return IDLE_STATES.has(this.ap.state());
  });

  protected readonly activeLabel = computed(() => {
    const id = this.activeProfileId();
    const p = this.profiles.profiles().find((x) => x.id === id);
    return p ? labelOf(p, this.profiles.knownRoomIds()) : '';
  });

  constructor() {
    void this.profiles.load();

    // Le serveur ne nomme la seed qu'apres le handshake.
    effect(() => {
      const roomId = this.ap.roomId();
      const id = this.activeProfileId();
      // Jamais depuis l'accueil : le profil designe revendiquerait la partie precedente.
      if (this.showConnect()) return;
      if (roomId === null || id === null) return;
      void this.profiles.attachRoom(id, roomId).then((owner) => {
        if (owner !== id && this.activeProfileId() === id) this.activeProfileId.set(owner);
      });
    });

    effect(() => {
      if (this.ap.state() !== 'unreachable') return;
      if (this.ap.localRoomId() !== null) return;
      const roomId = this.targetRoomId();
      if (roomId) void this.ap.browseLocal(roomId);
    });

  }

  /** Le mot de passe s'arrete ici : il n'est jamais stocke. */
  protected onConnectRequest(req: ConnectRequest): void {
    this.activeProfileId.set(req.profileId);
    this.ap.connect({
      host: req.host,
      port: req.port,
      slotName: req.slotName,
      password: req.password,
    });
  }

  protected onBrowseProfile(p: ConnectionProfile): void {
    if (!p.roomId || p.id === undefined) return;
    this.activeProfileId.set(p.id);
    void this.ap.browseLocal(p.roomId, { detached: true });
  }

  protected async onExportProfile(p: ConnectionProfile): Promise<void> {
    if (!p.roomId) return;
    this.archiveBusy.set(true);
    this.archiveNote.set(null);
    try {
      const res = await this.archive.exportArchive(p.roomId, this.exportMode());
      download(res.blob, res.filename);
      this.archiveNote.set(this.t('export.done', { file: res.filename, count: res.lines, size: formatBytes(res.blob.size, this.t) }));
    } catch (err) {
      this.archiveNote.set(this.t('export.failed', { error: String(err) }));
    } finally {
      this.archiveBusy.set(false);
    }
  }

  protected disconnect(): void {
    this.ap.disconnect();
    this.activeProfileId.set(null);
  }

  protected async doExport(): Promise<void> {
    const roomId = this.ap.roomId();
    if (roomId === null) return;
    this.archiveBusy.set(true);
    this.archiveNote.set(null);
    try {
      const res = await this.archive.exportArchive(roomId, this.exportMode());
      download(res.blob, res.filename);
      this.archiveNote.set(this.t('export.done', { file: res.filename, count: res.lines, size: formatBytes(res.blob.size, this.t) }));
    } catch (err) {
      this.archiveNote.set(this.t('export.failed', { error: String(err) }));
    } finally {
      this.archiveBusy.set(false);
    }
  }

  protected onArchiveFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    // Sinon rouvrir le meme fichier ne redeclenche pas l'evenement.
    input.value = '';
    if (file) void this.readArchive(file);
  }

  /** Sans `preventDefault`, le navigateur ouvre le fichier lui-meme. */
  protected onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    this.dragOver.set(true);
  }

  protected onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.dragOver.set(false);
    const file = ev.dataTransfer?.files?.[0];
    if (file && !this.archiveBusy()) void this.readArchive(file);
  }

  protected roomMatch(roomId: string): { key: Key; cls: string } {
    const open = this.ap.roomId();
    const known = this.profiles.knownRoomIds().includes(roomId);
    if (open === roomId) return { key: 'import.match.same', cls: 'same' };
    if (open !== null) {
      return known
        ? { key: 'import.match.otherKnown', cls: 'other' }
        : { key: 'import.match.other', cls: 'other' };
    }
    return known
      ? { key: 'import.match.known', cls: 'same' }
      : { key: 'import.match.new', cls: 'other' };
  }

  protected closeImport(): void {
    this.dialog.set(null);
    this.archiveNote.set(null);
    this.closeFileSummary();
  }

  /** Rien n'est ecrit en base ici. */
  private async readArchive(file: File): Promise<void> {

    this.archiveBusy.set(true);
    this.archiveNote.set(null);
    try {
      const text = await file.text();
      const { summary, reasons } = this.archive.inspect(text);
      this.pendingText = reasons.length ? null : text;
      this.fileName.set(file.name);
      this.fileSummary.set(summary);
      this.fileReasons.set(reasons.map((r) => this.t(r.key, r.params)));
      this.importReport.set(null);
    } catch (err) {
      this.pendingText = null;
      this.fileName.set(file.name);
      this.fileSummary.set(null);
      this.fileReasons.set([this.t('import.unreadable', { error: String(err) })]);
    } finally {
      this.archiveBusy.set(false);
    }
  }

  protected closeFileSummary(): void {
    this.fileSummary.set(null);
    this.fileReasons.set([]);
    this.fileName.set(null);
    this.importReport.set(null);
    this.addedProfiles.set([]);
    this.slotDraft.set({});
    this.slotNote.set(null);
    this.pendingText = null;
  }

  protected profileLabel(p: ConnectionProfile): string {
    return labelOf(p, this.profiles.knownRoomIds());
  }

  protected slotValue(p: ConnectionProfile): string {
    if (p.id === undefined) return p.slotName;
    const draft = this.slotDraft()[p.id];
    return draft === undefined ? p.slotName : draft;
  }

  protected onSlotDraft(p: ConnectionProfile, ev: Event): void {
    if (p.id === undefined) return;
    const value = (ev.target as HTMLInputElement).value;
    this.slotDraft.update((d) => ({ ...d, [p.id!]: value }));
  }

  protected async saveAddedSlot(p: ConnectionProfile): Promise<void> {
    if (p.id === undefined) return;
    const slotName = this.slotValue(p).trim();
    if (!slotName) {
      this.slotNote.set(this.t('import.slotEmpty'));
      return;
    }
    try {
      await this.profiles.edit(p.id, { slotName });
      this.addedProfiles.update((rows) => rows.filter((r) => r.id !== p.id));
      this.slotNote.set(this.t('import.slotSaved', { slot: slotName }));
    } catch (err) {
      this.slotNote.set(err instanceof DuplicateTargetError ? this.t('home.duplicate') : String(err instanceof Error ? err.message : err));
    }
  }

  protected readonly canImport = computed(
    () => this.fileSummary() !== null && this.fileReasons().length === 0 && this.importReport() === null,
  );

  protected async doImport(): Promise<void> {
    if (this.pendingText === null) return;
    this.archiveBusy.set(true);
    this.archiveNote.set(null);
    try {
      const report = await this.archive.importArchive(this.pendingText);
      this.importReport.set(report);
      this.pendingText = null;

      this.addedProfiles.set(await this.profiles.reloadAfterImport());
      this.slotDraft.set({});
      this.slotNote.set(null);

      // `reloadFromDb` remplace le journal : ne recharger que la room courante.
      const current = this.ap.roomId();
      if (current === null) {
        const first = report.roomIds[0];
        if (first !== undefined) await this.ap.reloadFromDb(first);
      } else if (report.roomIds.includes(current)) {
        await this.ap.reloadFromDb(current);
      }
    } catch (err) {
      this.archiveNote.set(this.t('import.aborted', { error: String(err) }));
    } finally {
      this.archiveBusy.set(false);
    }
  }

  protected offsetLabel(report: ImportReport): string {
    const count = report.offset.samples;
    if (!report.offset.reliable) return this.t('import.offset.unreliable', { count });
    if (report.offset.offsetMs === 0) return this.t('import.offset.aligned', { count });
    const sec = report.offset.offsetMs / 1000;
    return this.t(sec > 0 ? 'import.offset.ahead' : 'import.offset.behind', { count, sec: Math.abs(sec).toFixed(1) });
  }

  /** Motif ARIA des onglets : fleches, Debut et Fin ; la tabulation sort de la barre. */
  protected onTabKey(ev: KeyboardEvent): void {
    const keys = TABS.map((t) => t.key);
    const at = keys.indexOf(this.tab());
    let next: number;
    switch (ev.key) {
      case 'ArrowLeft':
        next = (at - 1 + keys.length) % keys.length;
        break;
      case 'ArrowRight':
        next = (at + 1) % keys.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = keys.length - 1;
        break;
      default:
        return;
    }
    ev.preventDefault();
    this.tab.set(keys[next]);
    const bar = (ev.target as HTMLElement).parentElement;
    (bar?.children[next] as HTMLElement | undefined)?.focus();
  }
}

function formatBytes(n: number, t: I18n['t']): string {
  if (n < 1024) return t('unit.b', { n });
  if (n < 1024 * 1024) return t('unit.kb', { n: (n / 1024).toFixed(0) });
  return t('unit.mb', { n: (n / (1024 * 1024)).toFixed(1) });
}
