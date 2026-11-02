import { manualUse } from '../protocol/permissions';
import type { Key } from '../i18n/en';

/** Pas de liste blanche : le serveur decide, on ne filtre que l'irreversible et le payant. */
export interface VerdictMessage {
  key: Key;
  params: Record<string, string | number>;
  effect?: Key;
}

export type CommandVerdict =
  | { kind: 'send' }
  | ({ kind: 'confirm' } & VerdictMessage)
  | ({ kind: 'refuse' } & VerdictMessage);

export interface CommandContext {
  permissions: Record<string, number>;
  hintPoints: number;
}

const IRREVERSIBLE: Record<string, { permission: string; effect: Key }> = {
  '!release': { permission: 'release', effect: 'cmd.effect.release' },
  '!collect': { permission: 'collect', effect: 'cmd.effect.collect' },
};

export function judgeCommand(raw: string, ctx: CommandContext): CommandVerdict {
  const text = raw.trim();
  if (!text) return { kind: 'refuse', key: 'cmd.empty', params: {} };

  if (!text.startsWith('!')) return { kind: 'send' };

  const [word, ...rest] = text.split(/\s+/);
  const cmd = word.toLowerCase();

  const danger = IRREVERSIBLE[cmd];
  if (danger) {
    const use = manualUse(ctx.permissions[danger.permission]);
    if (use === 'non') {
      return { kind: 'refuse', key: 'cmd.disabled', params: { cmd } };
    }
    if (use === 'apres-objectif') {
      return { kind: 'confirm', key: 'cmd.afterGoal', params: { cmd }, effect: danger.effect };
    }
    // Une permission non annoncee n'est pas une interdiction.
    return {
      kind: 'confirm',
      key: use === 'inconnu' ? 'cmd.finalUnknown' : 'cmd.final',
      params: {},
      effect: danger.effect,
    };
  }

  // `!hint` seul ne fait que lire ; avec un argument il depense des points.
  if (cmd === '!hint' && rest.length) {
    return { kind: 'confirm', key: 'cmd.hint', params: { count: ctx.hintPoints } };
  }

  return { kind: 'send' };
}
