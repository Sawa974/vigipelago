import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DuplicateTargetError, ProfileService, type DeletionPreview } from '../core/profile.service';
import { I18n } from '../i18n/i18n.service';
import { labelOf } from '../core/profiles';
import type { ConnectionProfile } from '../db/db';

/** Le mot de passe n'existe qu'ici : il n'est jamais memorise. */
export interface ConnectRequest {
  profileId: number;
  host: string;
  port: number;
  slotName: string;
  password: string;
}

/** L'ecran peut etre en stream : ne jamais y afficher l'hote ni le port d'une partie connue. */
@Component({
  selector: 'app-connect-screen',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './connect-screen.html',
  styleUrl: './connect-screen.css',
})
export class ConnectScreen {
  private readonly profiles = inject(ProfileService);
  private readonly i18n = inject(I18n);
  protected readonly t = this.i18n.t;

  readonly submitted = output<ConnectRequest>();
  readonly exportAsked = output<ConnectionProfile>();
  /** Ouverture depuis la base seule, sans toucher au serveur. */
  readonly browseAsked = output<ConnectionProfile>();

  readonly busy = input(false);
  readonly connectError = input<string | null>(null);

  /** Distincte de `connectError`, qui ne se nettoie pas en meme temps. */
  protected readonly error = signal<string | null>(null);
  protected readonly anyError = computed(() => this.error() ?? this.connectError());

  protected readonly rows = this.profiles.profiles;

  protected readonly openId = signal<number | null>(null);
  protected readonly editId = signal<number | null>(null);
  protected readonly confirmId = signal<number | null>(null);
  protected readonly confirmPreview = signal<DeletionPreview | null>(null);

  protected readonly password = signal('');
  protected readonly note = signal<string | null>(null);

  protected readonly adding = signal(false);
  protected readonly newLabel = signal('');
  protected readonly newHost = signal('');
  protected readonly newPort = signal(38281);
  protected readonly newSlot = signal('');
  protected readonly newPassword = signal('');

  protected readonly formOpen = computed(() => this.adding() || this.rows().length === 0);

  protected label(p: ConnectionProfile): string {
    return labelOf(p, this.profiles.knownRoomIds());
  }

  /** Le court-id a la place de l'hote : jamais l'url ni le port a l'ecran. */
  protected subtitle(p: ConnectionProfile): string {
    return p.roomId ? this.t('home.room', { id: this.profiles.short(p.roomId) }) : this.t('home.neverConnected');
  }

  protected lastUsedLabel(p: ConnectionProfile): string {
    if (!p.lastUsedAt) return '';
    return this.i18n.datetime(p.lastUsedAt);
  }

  protected open(p: ConnectionProfile): void {
    if (this.busy()) return;
    this.error.set(null);
    this.note.set(null);
    this.editId.set(null);
    this.confirmId.set(null);
    this.openId.set(this.openId() === p.id ? null : (p.id ?? null));
    this.password.set('');
  }

  protected submitKnown(p: ConnectionProfile): void {
    if (this.busy() || p.id === undefined) return;
    this.submitted.emit({
      profileId: p.id,
      host: p.host,
      port: p.port,
      slotName: p.slotName,
      password: this.password(),
    });
  }

  protected startAdding(): void {
    this.newLabel.set('');
    this.newHost.set('');
    this.newPort.set(38281);
    this.newSlot.set('');
    this.newPassword.set('');
    this.adding.set(true);
    this.openId.set(null);
    this.editId.set(null);
    this.error.set(null);
  }

  protected cancelAdding(): void {
    this.adding.set(false);
    this.newPassword.set('');
  }

  protected async submitNew(): Promise<void> {
    if (this.busy() || !this.newSlot().trim() || !this.newHost().trim()) return;
    this.error.set(null);
    const id = await this.profiles.remember({
      host: this.newHost(),
      port: this.newPort(),
      slotName: this.newSlot(),
      label: this.newLabel(),
    });
    this.submitted.emit({
      profileId: id,
      host: this.newHost().trim(),
      port: Number(this.newPort()),
      slotName: this.newSlot().trim(),
      password: this.newPassword(),
    });
    this.newPassword.set('');
  }

  protected readonly editLabel = signal('');
  protected readonly editHost = signal('');
  protected readonly editPort = signal(0);
  protected readonly editSlot = signal('');

  protected startEdit(p: ConnectionProfile): void {
    this.editId.set(p.id ?? null);
    this.openId.set(null);
    this.confirmId.set(null);
    this.error.set(null);
    this.editLabel.set(p.label);
    this.editHost.set(p.host);
    this.editPort.set(p.port);
    this.editSlot.set(p.slotName);
  }

  protected cancelEdit(): void {
    this.editId.set(null);
    this.error.set(null);
  }

  protected async saveEdit(p: ConnectionProfile): Promise<void> {
    if (p.id === undefined) return;
    if (!this.editSlot().trim()) {
      this.error.set(this.t('import.slotEmpty'));
      return;
    }
    try {
      await this.profiles.edit(p.id, {
        label: this.editLabel(),
        host: this.editHost(),
        port: this.editPort(),
        slotName: this.editSlot(),
      });
      this.editId.set(null);
      this.note.set(this.t('home.saved'));
    } catch (err) {
      this.error.set(err instanceof DuplicateTargetError ? this.t('home.duplicate') : String(err instanceof Error ? err.message : err));
    }
  }

  protected async askDelete(p: ConnectionProfile): Promise<void> {
    this.openId.set(null);
    this.editId.set(null);
    this.error.set(null);
    this.confirmPreview.set(await this.profiles.previewDeletion(p));
    this.confirmId.set(p.id ?? null);
  }

  protected cancelDelete(): void {
    this.confirmId.set(null);
    this.confirmPreview.set(null);
  }

  protected async confirmDelete(p: ConnectionProfile): Promise<void> {
    const before = this.confirmPreview();
    try {
      await this.profiles.remove(p);
      this.note.set(
        before && before.events
          ? this.t('home.deletedEvents', { name: this.label(p), count: before.events })
          : this.t('home.deleted', { name: this.label(p) }),
      );
    } catch (err) {
      this.error.set(this.t('home.deleteFailed', { error: String(err) }));
    } finally {
      this.cancelDelete();
    }
  }

  protected exportRow(p: ConnectionProfile): void {
    this.exportAsked.emit(p);
  }
}
