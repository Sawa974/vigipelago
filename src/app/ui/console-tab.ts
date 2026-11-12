import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApSessionService, FEED_FILTER_KEY, FEED_LIMIT, SEARCH_LIMIT } from '../core/ap-session.service';
import { judgeCommand, type VerdictMessage } from '../core/command-gate';
import { offlineMessage } from '../core/offline-message';
import { I18n } from '../i18n/i18n.service';
import { db, type ApEvent, type EventKind } from '../db/db';
import { FEED_CATEGORIES, feedMatcher, isFilterActive, type FeedCategory, type FeedFilter } from '../select/feed-filter';
import { mergeSearchWithLive } from '../select/feed-search';
import { toolChatterKeys } from '../select/tool-chatter';

const IDLE_STATES = new Set(['idle', 'fatal', 'unreachable']);

@Component({
  selector: 'app-console',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './console-tab.html',
  styleUrl: './console-tab.css',
})
export class ConsoleTab {
  protected readonly ap = inject(ApSessionService);
  private readonly i18n = inject(I18n);
  protected readonly t = this.i18n.t;

  protected readonly filter = signal('');
  protected readonly autoScroll = signal(true);

  protected readonly categories = FEED_CATEGORIES;
  protected readonly checkedCategories = signal<ReadonlySet<FeedCategory>>(new Set());
  protected readonly slotChecked = signal(false);

  protected readonly ownName = computed(() => {
    const slot = this.ap.ownSlot();
    return this.ap.players().find((p) => p.slot === slot)?.name ?? null;
  });

  private readonly feedFilter = computed<FeedFilter>(() => ({
    categories: this.checkedCategories(),
    slot: this.slotChecked() ? this.ap.ownSlot() : null,
  }));

  protected readonly filterActive = computed(() => isFilterActive(this.feedFilter()));

  /** `null` sans texte ni case : le journal vif suffit. */
  private readonly matcher = computed(() => feedMatcher(this.filter(), this.feedFilter()));

  /** `null` sans filtre actif : le journal vif suffit. */
  private readonly searchRows = signal<ApEvent[] | null>(null);
  protected readonly searching = signal(false);
  protected readonly feedLimit = FEED_LIMIT;
  protected readonly searchLimit = SEARCH_LIMIT;

  protected readonly input = signal('');
  protected readonly pendingWarning = signal<string | null>(null);
  protected readonly inputRefusal = signal<string | null>(null);

  private readonly console = viewChild<ElementRef<HTMLElement>>('console');
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly connected = computed(() => this.ap.state() === 'online');
  protected readonly busy = computed(() => !IDLE_STATES.has(this.ap.state()));

  /** `roomId` et non `localRoomId`, remis a `null` des qu'une connexion aboutit. */
  protected readonly offline = computed(
    () => this.ap.roomId() !== null && IDLE_STATES.has(this.ap.state()),
  );

  /** Ecran en stream : ne jamais y reprendre l'URL de `ap.detail()`. */
  protected readonly offlineReason = computed(() =>
    this.t(offlineMessage(this.ap.state(), this.ap.refusal())),
  );

  /** Lire `lang` recompose les lignes fabriquees (rattrapages, morts) quand la langue change. */
  protected readonly displayedEvents = computed(() => {
    this.i18n.lang();
    return this.visibleEvents().map((ev) =>
      ev.kind === 'death' || ev.tsPrecision === 'approx' ? { ...ev, segments: this.ap.relabel(ev) } : ev,
    );
  });

  /** Sous recherche, les lignes vives completent l'instantane de la base, sinon il reste fige. */
  protected readonly visibleEvents = computed(() => {
    const match = this.matcher();
    const rows = match ? mergeSearchWithLive(this.searchRows() ?? [], this.ap.feed(), match) : this.ap.feed();
    const chatter = toolChatterKeys(rows);
    return rows.filter((e) => !chatter.has(e.dedupKey));
  });

  protected readonly feedTruncated = computed(
    () => !this.matcher() && this.ap.feed().length >= FEED_LIMIT,
  );

  /** La recherche rapporte une ligne de plus que le plafond pour signaler le debordement. */
  protected readonly searchTruncated = computed(
    () => !!this.matcher() && (this.searchRows()?.length ?? 0) > SEARCH_LIMIT,
  );

  constructor() {
    // Differee : sinon chaque frappe balaierait toute la room en base.
    effect(() => {
      const match = this.matcher();
      if (this.searchTimer) clearTimeout(this.searchTimer);
      if (!match) {
        this.searchRows.set(null);
        this.searching.set(false);
        return;
      }
      this.searching.set(true);
      this.searchTimer = setTimeout(() => void this.runSearch(match), 250);
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
    });

    effect(() => {
      const roomId = this.ap.roomId();
      if (roomId) void this.loadFilter(roomId);
    });

    effect(() => {
      // Lu pour la dependance : refait defiler apres chaque lot rendu.
      this.visibleEvents();
      if (!this.autoScroll()) return;
      const el = this.console()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
  }

  private async runSearch(match: (e: ApEvent) => boolean): Promise<void> {
    const rows = await this.ap.searchFeed(match);
    // Une frappe ou une case plus recente a pu changer le critere.
    if (this.matcher() !== match) return;
    this.searchRows.set(rows);
    this.searching.set(false);
  }

  private async loadFilter(roomId: string): Promise<void> {
    const row = await db.settings.get(FEED_FILTER_KEY(roomId));
    if (this.ap.roomId() !== roomId) return;
    const v = (row?.value ?? {}) as { categories?: unknown; slot?: unknown };
    const saved = Array.isArray(v.categories) ? v.categories : [];
    this.checkedCategories.set(new Set(FEED_CATEGORIES.filter((c) => saved.includes(c))));
    this.slotChecked.set(v.slot === true);
  }

  private saveFilter(): void {
    const roomId = this.ap.roomId();
    if (!roomId) return;
    void db.settings.put({
      key: FEED_FILTER_KEY(roomId),
      value: { categories: [...this.checkedCategories()], slot: this.slotChecked() },
    });
  }

  protected toggleCategory(c: FeedCategory): void {
    const next = new Set(this.checkedCategories());
    if (next.has(c)) next.delete(c);
    else next.add(c);
    this.checkedCategories.set(next);
    this.saveFilter();
  }

  protected toggleSlot(): void {
    this.slotChecked.update((v) => !v);
    this.saveFilter();
  }

  protected clearFilter(): void {
    this.checkedCategories.set(new Set());
    this.slotChecked.set(false);
    this.saveFilter();
  }

  /** Pas de liste blanche de commandes : seul le serveur sait ce qu'il accepte. */
  protected submitLine(): void {
    this.inputRefusal.set(null);
    const verdict = judgeCommand(this.input(), {
      permissions: this.ap.permissions(),
      hintPoints: this.ap.hintPoints(),
    });
    switch (verdict.kind) {
      case 'refuse':
        this.pendingWarning.set(null);
        this.inputRefusal.set(this.say(verdict));
        return;
      case 'confirm':
        this.pendingWarning.set(this.say(verdict));
        return;
      case 'send':
        this.sendLine();
    }
  }

  protected sendLine(): void {
    if (!this.ap.say(this.input())) {
      this.inputRefusal.set(this.t('console.notSent'));
      return;
    }
    this.input.set('');
    this.pendingWarning.set(null);
    this.inputRefusal.set(null);
  }

  protected cancelLine(): void {
    this.pendingWarning.set(null);
  }

  protected reconnect(): void {
    this.ap.retry();
  }

  protected toggleAutoRetry(ev: Event): void {
    this.ap.setAutoRetry((ev.target as HTMLInputElement).checked);
  }

  protected onScroll(el: HTMLElement): void {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (this.autoScroll() !== atBottom) this.autoScroll.set(atBottom);
  }

  protected time(ts: number): string {
    return this.i18n.clock(ts, true);
  }

  protected catLabel(c: FeedCategory): string {
    return this.t(`console.cat.${c}`);
  }

  protected kindLabel(kind: EventKind): string {
    return this.t(`kind.${kind}`);
  }

  private say(v: VerdictMessage): string {
    return this.t(v.key, { ...v.params, effect: v.effect ? this.t(v.effect) : '' });
  }
}
