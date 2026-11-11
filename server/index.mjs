/**
 * Sert uniquement le bundle statique.
 * Ne relaie aucun WebSocket et ne stocke rien : toute la persistance est
 * cote navigateur (IndexedDB).
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'Vigipelago', 'browser');
const port = Number(process.env.PORT ?? 4300);

const app = Fastify({ logger: false });
await app.register(fastifyStatic, { root });
// L'application est mono-page : une route inconnue retourne index.html, mais un fichier absent (un ancien
// main-XXXX.js apres un deploiement) reste un 404, sinon le navigateur recoit du HTML a la place du script.
app.setNotFoundHandler((req, reply) =>
  /\.[a-z0-9]+$/i.test(req.url.split('?')[0]) ? reply.code(404).send() : reply.sendFile('index.html'),
);

await app.listen({ port, host: '0.0.0.0' });
console.log(`Vigipelago sur http://localhost:${port}`);
