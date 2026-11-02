import { describe, expect, it } from 'vitest';
import { judgeCommand, type CommandContext } from './command-gate';

const ctx: CommandContext = {
  permissions: { release: 0b001, collect: 0b001, remaining: 0b001 },
  hintPoints: 12,
};

describe('judgeCommand', () => {
  it('envoie un message public sans rien demander', () => {
    expect(judgeCommand('bien joue !', ctx).kind).toBe('send');
  });

  it('refuse une ligne vide', () => {
    expect(judgeCommand('   ', ctx).kind).toBe('refuse');
  });

  it('envoie une commande de lecture sans confirmation', () => {
    for (const c of ['!help', '!missing', '!players', '!status', '!remaining']) {
      expect(judgeCommand(c, ctx).kind).toBe('send');
    }
  });

  it('n invente aucune liste blanche : une commande inconnue part quand meme', () => {
    expect(judgeCommand('!commande_future arg', ctx).kind).toBe('send');
  });

  it('laisse passer !hint seul, qui ne fait que lire', () => {
    expect(judgeCommand('!hint', ctx).kind).toBe('send');
  });

  it('fait confirmer !hint avec un argument, en donnant les points', () => {
    const v = judgeCommand('!hint Bombos', ctx);
    expect(v.kind).toBe('confirm');
    if (v.kind === 'confirm') expect(v.params['count']).toBe(12);
  });

  it('fait confirmer release et collect quand le serveur les autorise', () => {
    expect(judgeCommand('!release', ctx).kind).toBe('confirm');
    expect(judgeCommand('!collect', ctx).kind).toBe('confirm');
  });

  it('refuse release quand le serveur l a desactive', () => {
    const v = judgeCommand('!release', { ...ctx, permissions: { release: 0b000 } });
    expect(v.kind).toBe('refuse');
  });

  it('avertit quand le serveur ne l autorise qu apres l objectif', () => {
    const v = judgeCommand('!collect', { ...ctx, permissions: { collect: 0b010 } });
    expect(v.kind).toBe('confirm');
    if (v.kind === 'confirm') expect(v.key).toBe('cmd.afterGoal');
  });

  it('ne refuse pas a la place d un serveur qui n a rien annonce', () => {
    const v = judgeCommand('!release', { ...ctx, permissions: {} });
    expect(v.kind).toBe('confirm');
    if (v.kind === 'confirm') expect(v.key).toBe('cmd.finalUnknown');
  });

  it('reconnait la commande quelle que soit la casse et l espacement', () => {
    expect(judgeCommand('  !RELEASE  ', { ...ctx, permissions: { release: 0 } }).kind).toBe('refuse');
  });
});
