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
// L'application est mono-page : toute route inconnue retourne index.html.
app.setNotFoundHandler((_req, reply) => reply.sendFile('index.html'));

await app.listen({ port, host: '0.0.0.0' });
console.log(`Vigipelago sur http://localhost:${port}`);
