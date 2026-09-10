// Script de backup — roda fora do servidor HTTP, sob demanda (via
// `docker compose exec api node src/backup.js [nome-do-snapshot]`),
// tipicamente disparado por uma tarefa agendada do sistema operacional.
//
// Recria em disco a mesma estrutura de pastas/subpastas navegada no app
// (Pedagógico e Secretaria/Administração), copiando o conteúdo de cada
// documento do MinIO para o caminho correspondente. Não aplica as regras de
// visibilidade por perfil — é um backup administrativo completo, não uma
// exportação do que um usuário específico enxergaria.
//
// Também grava um manifest.json ligando cada documento (pelo storageKey já
// usado no banco) ao caminho do arquivo copiado — é o que permite ao
// restore.js devolver cada arquivo ao MinIO na chave exata que o banco
// restaurado espera, sem precisar reescrever nada no banco.
import 'dotenv/config';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';

import { prisma } from './prisma.js';
import { getObjectStream } from './storage.js';

// Caminho fixo dentro do container — o docker-compose monta o disco/pasta
// escolhido pelo usuário (BACKUP_HOST_PATH no .env) exatamente aqui.
const BACKUP_ROOT = '/backup';

const CATEGORY_DIRS = {
  TURMA: 'Pedagogico',
  SECRETARIA: 'Secretaria-Administracao',
};

// Remove caracteres inválidos em nomes de arquivo/pasta no Windows
// (< > : " / \ | ? *) e espaços/pontos finais, que o Windows também rejeita.
function sanitizeName(name) {
  const clean = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  return clean || 'sem-nome';
}

// Evita colisão quando duas pastas/arquivos, depois de sanitizados, ficam
// com o mesmo nome dentro do mesmo diretório.
function uniqueName(usedNames, baseName) {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  let n = 1;
  let candidate = `${stem} (${n})${ext}`;
  while (usedNames.has(candidate)) {
    n += 1;
    candidate = `${stem} (${n})${ext}`;
  }
  usedNames.add(candidate);
  return candidate;
}

async function run() {
  const snapshot = process.argv[2] || new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const snapshotRoot = path.join(BACKUP_ROOT, snapshot);
  const filesRoot = path.join(snapshotRoot, 'files');

  console.log(`[backup] Iniciando backup de arquivos — snapshot "${snapshot}"`);

  const [folders, documents] = await Promise.all([
    prisma.folder.findMany({ select: { id: true, name: true, parentId: true, category: true } }),
    prisma.document.findMany({
      select: { id: true, name: true, originalName: true, mimeType: true, folderId: true, storageKey: true },
    }),
  ]);

  // Monta o índice de filhos por pasta pai (raízes agrupadas por categoria)
  // e de documentos por pasta, para percorrer a árvore inteira em memória
  // sem uma consulta ao banco por nó.
  const childrenByParent = new Map();
  for (const f of folders) {
    const key = f.parentId || `root:${f.category}`;
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(f);
  }

  const docsByFolder = new Map();
  for (const d of documents) {
    if (!docsByFolder.has(d.folderId)) docsByFolder.set(d.folderId, []);
    docsByFolder.get(d.folderId).push(d);
  }

  let folderCount = 0;
  let fileCount = 0;
  const errors = [];
  const manifest = [];

  async function walk(folder, dirPath, relDirPath) {
    await fsp.mkdir(dirPath, { recursive: true });
    folderCount += 1;

    const usedFileNames = new Set();
    for (const doc of docsByFolder.get(folder.id) || []) {
      const ext = doc.originalName.includes('.') ? `.${doc.originalName.split('.').pop()}` : '';
      const finalName = uniqueName(usedFileNames, `${sanitizeName(doc.name)}${ext}`);
      const destPath = path.join(dirPath, finalName);
      const relPath = path.join(relDirPath, finalName);

      try {
        const stream = await getObjectStream(doc.storageKey);
        await pipeline(stream, fs.createWriteStream(destPath));
        fileCount += 1;
        manifest.push({
          documentId: doc.id,
          name: doc.name,
          storageKey: doc.storageKey,
          mimeType: doc.mimeType,
          path: relPath,
        });
      } catch (err) {
        errors.push(`${destPath}: ${err.message}`);
        console.error(`[backup] Falha ao copiar "${doc.name}": ${err.message}`);
      }
    }

    const usedFolderNames = new Set();
    for (const child of childrenByParent.get(folder.id) || []) {
      const childDirName = uniqueName(usedFolderNames, sanitizeName(child.name));
      await walk(child, path.join(dirPath, childDirName), path.join(relDirPath, childDirName));
    }
  }

  for (const [category, dirName] of Object.entries(CATEGORY_DIRS)) {
    const categoryDir = path.join(filesRoot, dirName);
    await fsp.mkdir(categoryDir, { recursive: true });

    const usedRootNames = new Set();
    for (const root of childrenByParent.get(`root:${category}`) || []) {
      const rootDirName = uniqueName(usedRootNames, sanitizeName(root.name));
      await walk(root, path.join(categoryDir, rootDirName), path.join(dirName, rootDirName));
    }
  }

  await fsp.writeFile(path.join(snapshotRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`[backup] Concluído: ${folderCount} pasta(s), ${fileCount} arquivo(s) copiado(s), ${errors.length} erro(s).`);
  if (errors.length) {
    console.error('[backup] Itens com falha:');
    errors.forEach((e) => console.error(`  - ${e}`));
  }

  await prisma.$disconnect();
  process.exit(errors.length > 0 ? 1 : 0);
}

run().catch(async (err) => {
  console.error('[backup] Erro fatal:', err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
