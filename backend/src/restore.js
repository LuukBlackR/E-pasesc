// Script de restauração de arquivos — roda fora do servidor HTTP, sob
// demanda (via `docker compose exec api node src/restore.js <snapshot>` ou,
// preferencialmente, `docker compose run --rm api node src/restore.js
// <snapshot>` para não depender do container principal estar de pé).
//
// Reenvia cada arquivo do snapshot de backup para o MinIO, usando o
// manifest.json gerado pelo backup.js para saber a chave (storageKey)
// exata que o banco de dados restaurado espera — sem isso, o banco listaria
// os documentos normalmente, mas o download de cada um falharia por
// apontar para um objeto inexistente no MinIO.
//
// Pressupõe que o banco de dados já foi restaurado antes (ver
// scripts/restaurar.ps1) — este script só cuida do conteúdo dos arquivos.
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';

import { prisma } from './prisma.js';
import { putObject } from './storage.js';

const BACKUP_ROOT = '/backup';

async function run() {
  const snapshot = process.argv[2];
  if (!snapshot) {
    console.error('[restore] Uso: node src/restore.js <nome-do-snapshot>');
    process.exit(1);
  }

  const snapshotRoot = path.join(BACKUP_ROOT, snapshot);
  const manifestPath = path.join(snapshotRoot, 'manifest.json');

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`[restore] Não foi possível ler "${manifestPath}": ${err.message}`);
    process.exit(1);
  }

  console.log(`[restore] Restaurando ${manifest.length} arquivo(s) do snapshot "${snapshot}" para o MinIO...`);

  let okCount = 0;
  const errors = [];

  for (const entry of manifest) {
    const filePath = path.join(snapshotRoot, 'files', entry.path);
    try {
      const body = await fs.readFile(filePath);
      await putObject(entry.storageKey, body, entry.mimeType);
      okCount += 1;
    } catch (err) {
      errors.push(`${entry.name} (${entry.storageKey}): ${err.message}`);
      console.error(`[restore] Falha ao restaurar "${entry.name}": ${err.message}`);
    }
  }

  console.log(`[restore] Concluído: ${okCount} arquivo(s) restaurado(s), ${errors.length} erro(s).`);
  if (errors.length) {
    console.error('[restore] Itens com falha:');
    errors.forEach((e) => console.error(`  - ${e}`));
  }

  // Confere se o banco restaurado e o manifesto batem: documentos cujo
  // storageKey não apareceu no manifesto ficariam "órfãos" (apontando para
  // um objeto que nunca foi reenviado ao MinIO) — vale avisar, não é um
  // erro que impede a restauração de seguir.
  const manifestKeys = new Set(manifest.map((m) => m.storageKey));
  const documents = await prisma.document.findMany({ select: { name: true, storageKey: true } });
  const orphaned = documents.filter((d) => !manifestKeys.has(d.storageKey));
  if (orphaned.length) {
    console.warn(`[restore] Aviso: ${orphaned.length} documento(s) no banco não têm arquivo correspondente neste snapshot:`);
    orphaned.forEach((d) => console.warn(`  - ${d.name}`));
  }

  await prisma.$disconnect();
  process.exit(errors.length > 0 ? 1 : 0);
}

run().catch(async (err) => {
  console.error('[restore] Erro fatal:', err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
