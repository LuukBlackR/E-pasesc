import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import crypto from 'crypto';
import { z } from 'zod';
import pino from 'pino';
import archiver from 'archiver';
import ExcelJS from 'exceljs';

import { prisma } from './prisma.js';
import { uploadUrl, downloadUrl, deleteObject, getObjectStream, publicOriginFromRequest } from './storage.js';
import {
  isSuperior,
  isFolderVisible,
  isFolderChainVisible,
  resolveFolderVisibilityFlags,
} from './permissions.js';

// =============================================================================
// Configuração do servidor
// =============================================================================

const app = express();
const log = pino({ level: process.env.LOG_LEVEL || 'info' });

const REQUIRED_ENV = ['JWT_SECRET', 'DATABASE_URL', 'S3_BUCKET'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    log.error(`Variável de ambiente obrigatória ausente: ${key}`);
    process.exit(1);
  }
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// =============================================================================
// CORS — acesso de outros dispositivos na rede (celulares, notebooks, etc.)
// =============================================================================
// APP_ORIGIN pode conter uma lista separada por vírgulas (ex.: domínio de
// produção). Além disso, como este sistema roda numa rede local/escolar sem
// domínio público, qualquer origem dentro de faixas de IP privadas (ou
// localhost) é aceita automaticamente — assim cada dispositivo consegue
// acessar pelo IP da máquina que está rodando o Docker, sem precisar
// configurar cada IP manualmente no .env.
const configuredOrigins = (process.env.APP_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const PRIVATE_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})(?::\d+)?$/;

app.use(
  cors({
    origin(origin, callback) {
      // Requisições sem cabeçalho Origin (ex.: chamadas diretas de servidor,
      // curl, health checks) não passam pela política de CORS do navegador.
      if (!origin) return callback(null, true);
      if (configuredOrigins.includes(origin) || PRIVATE_ORIGIN_RE.test(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Origem não permitida pelo CORS'));
    },
    credentials: true,
  })
);

// =============================================================================
// Rate limiting
// =============================================================================

const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const apiLimit = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimit);

// =============================================================================
// Middlewares
// =============================================================================

function auth(req, res, next) {
  try {
    const token = req.cookies.access_token;
    if (!token) return res.status(401).json({ error: 'Não autenticado' });
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Sessão inválida ou expirada' });
  }
}

function role(...roles) {
  return (req, res, next) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Permissão insuficiente' });
}

async function audit(req, action, entity, entityId, metadata = {}) {
  try {
    await prisma.auditLog.create({
      data: { action, entity, entityId, userId: req.user?.sub, ip: req.ip, metadata },
    });
  } catch (err) {
    log.error({ err }, 'audit_log_failed');
  }
  log.info({ action, entity, entityId, userId: req.user?.sub }, 'audit');
}

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// =============================================================================
// Geração de nome de usuário a partir do nome completo
// =============================================================================
// Regra: primeiro nome + último sobrenome, em CamelCase, sem acentos.
// Ex.: "Maria Clara Pereira" -> "MariaPereira". Se já existir, acrescenta um
// sufixo numérico crescente: "MariaPereira1", "MariaPereira2", ...

function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function toNamePart(word) {
  const clean = stripAccents(word).replace(/[^a-zA-Z]/g, '');
  if (!clean) return '';
  return clean[0].toUpperCase() + clean.slice(1).toLowerCase();
}

function baseUsernameFromName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Usuario';
  const first = toNamePart(parts[0]);
  const last = parts.length > 1 ? toNamePart(parts[parts.length - 1]) : '';
  const base = `${first}${last}` || 'Usuario';
  return base;
}

async function generateUniqueUsername(fullName) {
  const base = baseUsernameFromName(fullName);
  let candidate = base;
  let suffix = 0;
  // Busca sequencial até achar um nome de usuário livre — o volume de
  // usuários de uma escola é pequeno o suficiente para isso ser instantâneo.
  // Comparação sem diferenciar maiúsculas/minúsculas para evitar confusão
  // entre "MariaPereira" e "mariapereira".
  while (
    await prisma.user.findFirst({
      where: { username: { equals: candidate, mode: 'insensitive' } },
      select: { id: true },
    })
  ) {
    suffix += 1;
    candidate = `${base}${suffix}`;
  }
  return candidate;
}

const CATEGORIES = ['TURMA', 'SECRETARIA'];

// =============================================================================
// Rotas - Health
// =============================================================================

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// =============================================================================
// Rotas - Autenticação
// =============================================================================

app.get(
  '/api/auth/setup-status',
  asyncRoute(async (req, res) => {
    const count = await prisma.user.count();
    res.json({ needsSetup: count === 0 });
  })
);

app.post(
  '/api/auth/register',
  asyncRoute(async (req, res) => {
    const userCount = await prisma.user.count();
    const isBootstrap = userCount === 0;

    // Identifica um solicitante autenticado, se houver, sem exigir login —
    // o cadastro público (autocadastro) precisa funcionar sem sessão. Se o
    // token existir mas estiver inválido/expirado, apenas ignora.
    let requester = null;
    const token = req.cookies.access_token;
    if (token) {
      try {
        requester = jwt.verify(token, process.env.JWT_SECRET);
      } catch {
        /* token inválido/expirado: trata como visitante anônimo */
      }
    }
    req.user = requester;

    return createUser(req, res, { isBootstrap, requester });
  })
);

async function createUser(req, res, { isBootstrap, requester }) {
  const schema = z
    .object({
      name: z.string().min(2),
      password: z.string().min(10),
      confirmPassword: z.string().min(1),
      role: z.enum(['ADMIN', 'TEACHER', 'STAFF']).default('TEACHER'),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: 'As senhas não conferem',
      path: ['confirmPassword'],
    });

  const body = schema.parse(req.body);

  let finalRole;
  if (isBootstrap) {
    finalRole = 'ADMIN';
  } else if (requester?.role === 'ADMIN') {
    // Administrador autenticado cadastrando alguém pelo painel: pode
    // escolher qualquer perfil, inclusive outro administrador.
    finalRole = body.role;
  } else {
    // Autocadastro público (visitante, ou secretaria/professor sem sessão
    // de admin): nunca pode se autoconceder o papel de administrador.
    if (body.role === 'ADMIN') {
      return res.status(403).json({
        error: 'Não é possível se cadastrar como administrador. Peça para um administrador criar essa conta.',
      });
    }
    finalRole = body.role;
  }

  const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
  const username = await generateUniqueUsername(body.name);

  // Fluxo de aprovação: todo usuário criado começa inativo (pendente) e só
  // pode entrar depois que a secretaria ou administração aprovar. A única
  // exceção é o primeiro administrador (bootstrap) — não existe ninguém
  // ainda para aprová-lo.
  const active = isBootstrap;

  const u = await prisma.user.create({
    data: { name: body.name, username, passwordHash, role: finalRole, active },
    select: { id: true, name: true, username: true, role: true, active: true },
  });

  if (!isBootstrap) {
    await audit(req, 'CREATE_USER', 'User', u.id, { username: u.username, role: u.role, selfRegistered: !requester });
  } else {
    log.info({ userId: u.id }, 'bootstrap_admin_created');
  }

  res.status(201).json(u);
}

app.post(
  '/api/auth/login',
  authLimit,
  asyncRoute(async (req, res) => {
    const { username, password } = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body);

    const u = await prisma.user.findFirst({ where: { username: { equals: username.trim(), mode: 'insensitive' } } });
    if (!u || !(await argon2.verify(u.passwordHash, password))) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    if (!u.active) {
      return res.status(403).json({
        error: 'Seu cadastro ainda está aguardando aprovação da secretaria ou administração.',
      });
    }

    const token = jwt.sign({ sub: u.id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.cookie('access_token', token, {
      httpOnly: true,
      // O flag "Secure" só pode ser usado quando a conexão É de fato HTTPS —
      // caso contrário o navegador descarta o cookie silenciosamente (é
      // exatamente isso que quebra o login em outros dispositivos da rede,
      // que acessam por IP via HTTP simples, sem a exceção que "localhost"
      // recebe no navegador do computador). req.secure reflete a conexão
      // real (via X-Forwarded-Proto, com trust proxy habilitado), não o
      // ambiente (NODE_ENV) — funciona certo tanto em HTTP na rede local
      // quanto em HTTPS de verdade, se um domínio/certificado for adicionado.
      secure: req.secure,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
    });

    await audit({ user: { sub: u.id }, ip: req.ip }, 'LOGIN', 'User', u.id);
    res.json({ id: u.id, name: u.name, username: u.username, role: u.role });
  })
);

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('access_token');
  res.status(204).end();
});

// Solicitação de "esqueci minha senha": pública (sem login, já que quem
// esqueceu a senha não consegue entrar). Não confirma se o usuário existe
// ou não na resposta, para não expor quais nomes de usuário são válidos —
// só marca a solicitação para quem gerencia usuários resolver.
app.post(
  '/api/auth/forgot-password',
  authLimit,
  asyncRoute(async (req, res) => {
    const { username } = z.object({ username: z.string().min(1) }).parse(req.body);

    const u = await prisma.user.findFirst({ where: { username: { equals: username.trim(), mode: 'insensitive' } } });
    if (u) {
      await prisma.user.update({ where: { id: u.id }, data: { passwordResetRequested: true } });
      await audit({ ip: req.ip }, 'PASSWORD_RESET_REQUEST', 'User', u.id, {
        targetName: u.name,
        targetUsername: u.username,
      });
    }

    res.json({ ok: true });
  })
);

app.get(
  '/api/auth/me',
  auth,
  asyncRoute(async (req, res) => {
    const u = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { id: true, name: true, username: true, role: true },
    });
    if (!u) return res.status(401).json({ error: 'Sessão inválida' });
    res.json(u);
  })
);

// =============================================================================
// Rotas - Foto de perfil (autoatendimento: só a própria pessoa)
// =============================================================================

const AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

app.post(
  '/api/auth/avatar/upload-url',
  auth,
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        mimeType: z.string(),
        sizeBytes: z.number().int().positive().max(AVATAR_MAX_BYTES),
      })
      .parse(req.body);

    if (!AVATAR_MIME_TYPES.includes(b.mimeType)) {
      return res.status(400).json({ error: 'Use uma imagem JPG, PNG ou WEBP' });
    }

    const ext = b.mimeType.split('/')[1];
    const key = `avatars/${req.user.sub}-${crypto.randomUUID()}.${ext}`;
    const url = await uploadUrl(key, b.mimeType, publicOriginFromRequest(req));

    res.json({ uploadUrl: url, key });
  })
);

app.patch(
  '/api/auth/avatar',
  auth,
  asyncRoute(async (req, res) => {
    const { key } = z.object({ key: z.string().min(1) }).parse(req.body);

    const current = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (current.avatarKey) {
      await deleteObject(current.avatarKey).catch((err) => log.error({ err }, 'delete_avatar_failed'));
    }

    await prisma.user.update({ where: { id: req.user.sub }, data: { avatarKey: key } });
    await audit(req, 'UPDATE_AVATAR', 'User', req.user.sub, {});
    res.status(204).end();
  })
);

app.get(
  '/api/auth/avatar-url',
  auth,
  asyncRoute(async (req, res) => {
    const u = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!u?.avatarKey) return res.json({ url: null });
    res.json({ url: await downloadUrl(u.avatarKey, publicOriginFromRequest(req)) });
  })
);

// =============================================================================
// Rotas - Usuários (administração)
// =============================================================================

app.get(
  '/api/users',
  auth,
  role('ADMIN', 'STAFF'),
  asyncRoute(async (req, res) => {
    res.json(
      await prisma.user.findMany({
        select: { id: true, name: true, username: true, role: true, active: true, passwordResetRequested: true, createdAt: true },
        orderBy: [{ active: 'asc' }, { name: 'asc' }],
      })
    );
  })
);

app.patch(
  '/api/users/:id',
  auth,
  role('ADMIN', 'STAFF'),
  asyncRoute(async (req, res) => {
    const body = z
      .object({ active: z.boolean().optional(), role: z.enum(['ADMIN', 'TEACHER', 'STAFF']).optional() })
      .parse(req.body);

    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });

    if (req.params.id === req.user.sub && body.active === false) {
      return res.status(400).json({ error: 'Você não pode desativar seu próprio usuário' });
    }

    // Secretaria pode aprovar/gerenciar apenas quem tem hierarquia inferior
    // (professores) e nunca pode alterar o perfil de ninguém — só um
    // administrador reatribui papéis.
    if (req.user.role === 'STAFF') {
      if (body.role !== undefined) {
        return res.status(403).json({ error: 'Somente administradores podem alterar o perfil de um usuário' });
      }
      if (!isSuperior(req.user.role, target.role)) {
        return res.status(403).json({ error: 'Permissão insuficiente para gerenciar este usuário' });
      }
    }

    const u = await prisma.user.update({
      where: { id: req.params.id },
      data: body,
      select: { id: true, name: true, username: true, role: true, active: true },
    });

    const wasApproval = body.active === true && !target.active;
    await audit(req, wasApproval ? 'APPROVE_USER' : 'UPDATE_USER', 'User', u.id, {
      ...body,
      targetName: target.name,
      targetUsername: target.username,
    });
    res.json(u);
  })
);

// Rejeita um cadastro pendente: exclui o usuário da lista. Só é permitido
// para contas ainda não aprovadas (pendentes) — para não virar um jeito
// disfarçado de apagar contas já ativas.
app.delete(
  '/api/users/:id',
  auth,
  role('ADMIN', 'STAFF'),
  asyncRoute(async (req, res) => {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });

    if (target.active) {
      return res.status(400).json({ error: 'Só é possível rejeitar cadastros pendentes de aprovação' });
    }
    if (req.user.role === 'STAFF' && !isSuperior(req.user.role, target.role)) {
      return res.status(403).json({ error: 'Permissão insuficiente para rejeitar este cadastro' });
    }

    await prisma.user.delete({ where: { id: target.id } });
    await audit(req, 'REJECT_USER', 'User', target.id, { username: target.username, role: target.role });
    res.status(204).end();
  })
);

// Redefine a senha de um usuário — usado tanto para resolver um pedido de
// "esqueci minha senha" quanto para qualquer redefinição avulsa feita pela
// secretaria/administração. Segue a mesma regra de hierarquia das demais
// ações de gestão de usuários.
app.patch(
  '/api/users/:id/reset-password',
  auth,
  role('ADMIN', 'STAFF'),
  asyncRoute(async (req, res) => {
    const { newPassword } = z.object({ newPassword: z.string().min(10) }).parse(req.body);

    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });

    if (req.user.role === 'STAFF' && !isSuperior(req.user.role, target.role)) {
      return res.status(403).json({ error: 'Permissão insuficiente para redefinir a senha deste usuário' });
    }

    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await prisma.user.update({
      where: { id: target.id },
      data: { passwordHash, passwordResetRequested: false },
    });

    // Nunca registra a senha em si no log de auditoria — só quem fez o quê.
    await audit(req, 'RESET_PASSWORD', 'User', target.id, {
      targetName: target.name,
      targetUsername: target.username,
    });

    res.status(204).end();
  })
);

// =============================================================================
// Rotas - Pastas (Pedagógico / Secretaria-Administração)
// =============================================================================

// Lista achatada de todas as pastas que o usuário pode acessar (qualquer
// profundidade), com o caminho completo — usado nos seletores de pasta do
// menu Documentos e no formulário de upload.
app.get(
  '/api/folders/flat',
  auth,
  asyncRoute(async (req, res) => {
    const category = String(req.query.category || '').toUpperCase();
    const where = CATEGORIES.includes(category) ? { category } : {};
    const all = await prisma.folder.findMany({ where, orderBy: { name: 'asc' } });
    const byId = new Map(all.map((f) => [f.id, f]));

    function chainVisible(folder) {
      let cur = folder;
      while (cur) {
        if (!isFolderVisible(req.user, cur)) return false;
        if (!cur.parentId) return true;
        cur = byId.get(cur.parentId);
        if (!cur) return false;
      }
      return true;
    }

    function pathOf(folder) {
      const parts = [folder.name];
      let cur = folder;
      while (cur.parentId) {
        cur = byId.get(cur.parentId);
        if (!cur) break;
        parts.unshift(cur.name);
      }
      return parts.join(' / ');
    }

    res.json(
      all
        .filter(chainVisible)
        .map((f) => ({ id: f.id, name: f.name, category: f.category, parentId: f.parentId, path: pathOf(f) }))
    );
  })
);

// Pastas raiz de uma categoria (Pedagógico ou Secretaria/Administração)
app.get(
  '/api/folders',
  auth,
  asyncRoute(async (req, res) => {
    const category = String(req.query.category || '').toUpperCase();
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Categoria inválida' });

    const roots = await prisma.folder.findMany({
      where: { category, parentId: null },
      include: { creator: { select: { name: true } }, _count: { select: { children: true, documents: true } } },
      orderBy: { name: 'asc' },
    });

    res.json(roots.filter((f) => isFolderVisible(req.user, f)));
  })
);

// Detalhe de uma pasta: breadcrumb + subpastas + documentos diretos
app.get(
  '/api/folders/:id',
  auth,
  asyncRoute(async (req, res) => {
    const folder = await prisma.folder.findUnique({
      where: { id: req.params.id },
      include: { creator: { select: { name: true } } },
    });
    if (!folder) return res.status(404).json({ error: 'Pasta não encontrada' });
    if (!(await isFolderChainVisible(prisma, req.user, folder))) {
      return res.status(403).json({ error: 'Permissão insuficiente' });
    }

    const breadcrumb = [];
    let cur = folder;
    while (cur) {
      breadcrumb.unshift({ id: cur.id, name: cur.name });
      cur = cur.parentId ? await prisma.folder.findUnique({ where: { id: cur.parentId } }) : null;
    }

    const children = await prisma.folder.findMany({
      where: { parentId: folder.id },
      include: { creator: { select: { name: true } }, _count: { select: { children: true, documents: true } } },
      orderBy: { name: 'asc' },
    });

    const documents = await prisma.document.findMany({
      where: { folderId: folder.id },
      include: { owner: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      folder: { ...folder, creatorName: folder.creator.name },
      breadcrumb,
      children: children.filter((f) => isFolderVisible(req.user, f)),
      documents,
    });
  })
);

app.post(
  '/api/folders',
  auth,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(2).max(120),
        parentId: z.string().uuid().nullable().optional(),
        category: z.enum(CATEGORIES).optional(),
        visibleToTeachers: z.boolean().optional(),
        visibleToStaff: z.boolean().optional(),
      })
      .parse(req.body);

    const parentId = body.parentId || null;
    let category;
    let parentName = null;

    if (!parentId) {
      if (!body.category) return res.status(400).json({ error: 'Categoria é obrigatória para pasta raiz' });
      category = body.category;

      // Pasta raiz de Secretaria/Administração: só Secretaria ou Administração.
      // Pasta raiz Pedagógico (Turma): Secretaria, Administração OU professor.
      const allowedRoles =
        category === 'SECRETARIA' ? ['STAFF', 'ADMIN'] : ['STAFF', 'ADMIN', 'TEACHER'];
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
          error:
            category === 'SECRETARIA'
              ? 'Apenas secretaria ou administração podem criar pastas em Secretaria/Administração'
              : 'Permissão insuficiente para criar pastas',
        });
      }
    } else {
      // Subpasta: aberta a qualquer usuário autenticado que já tenha acesso
      // à pasta pai.
      const parentFolder = await prisma.folder.findUnique({ where: { id: parentId } });
      if (!parentFolder) return res.status(404).json({ error: 'Pasta pai não encontrada' });
      if (!(await isFolderChainVisible(prisma, req.user, parentFolder))) {
        return res.status(403).json({ error: 'Permissão insuficiente' });
      }
      category = parentFolder.category;
      parentName = parentFolder.name;
    }

    const existing = await prisma.folder.findFirst({
      where: { parentId, name: { equals: body.name, mode: 'insensitive' } },
    });
    if (existing) return res.status(409).json({ error: 'Já existe uma pasta com esse nome neste local' });

    const visibility = resolveFolderVisibilityFlags(req.user.role, body);

    const folder = await prisma.folder.create({
      data: {
        name: body.name,
        category,
        parentId,
        creatorId: req.user.sub,
        creatorRole: req.user.role,
        ...visibility,
      },
    });

    await audit(req, parentId ? 'CREATE_SUBFOLDER' : 'CREATE_FOLDER', 'Folder', folder.id, {
      name: folder.name,
      category,
      parentId,
      parentName,
    });

    res.status(201).json(folder);
  })
);

// Alterar uma pasta (nome e/ou visibilidade): quem criou ou hierarquia superior
app.patch(
  '/api/folders/:id',
  auth,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(2).max(120).optional(),
        visibleToTeachers: z.boolean().optional(),
        visibleToStaff: z.boolean().optional(),
      })
      .parse(req.body);

    const folder = await prisma.folder.findUnique({ where: { id: req.params.id } });
    if (!folder) return res.status(404).json({ error: 'Pasta não encontrada' });

    const allowed = folder.creatorId === req.user.sub || isSuperior(req.user.role, folder.creatorRole);
    if (!allowed) return res.status(403).json({ error: 'Permissão insuficiente' });

    const data = {};
    const changes = { folderName: folder.name };

    if (body.name !== undefined && body.name !== folder.name) {
      const duplicate = await prisma.folder.findFirst({
        where: {
          parentId: folder.parentId,
          id: { not: folder.id },
          name: { equals: body.name, mode: 'insensitive' },
        },
      });
      if (duplicate) return res.status(409).json({ error: 'Já existe uma pasta com esse nome neste local' });
      data.name = body.name;
      changes.rename = { from: folder.name, to: body.name };
    }

    if (body.visibleToTeachers !== undefined || body.visibleToStaff !== undefined) {
      const visibility = resolveFolderVisibilityFlags(folder.creatorRole, {
        visibleToTeachers: body.visibleToTeachers ?? folder.visibleToTeachers,
        visibleToStaff: body.visibleToStaff ?? folder.visibleToStaff,
      });
      Object.assign(data, visibility);
      changes.visibility = visibility;
    }

    if (Object.keys(data).length === 0) return res.json(folder);

    const updated = await prisma.folder.update({ where: { id: folder.id }, data });
    await audit(req, changes.rename ? 'RENAME_FOLDER' : 'UPDATE_FOLDER', 'Folder', folder.id, changes);
    res.json(updated);
  })
);

// Baixa a pasta inteira (e todas as subpastas visíveis ao usuário) como um
// único arquivo .zip, preservando a estrutura de subpastas.
app.get(
  '/api/folders/:id/download-zip',
  auth,
  asyncRoute(async (req, res) => {
    const folder = await prisma.folder.findUnique({ where: { id: req.params.id } });
    if (!folder) return res.status(404).json({ error: 'Pasta não encontrada' });
    if (!(await isFolderChainVisible(prisma, req.user, folder))) {
      return res.status(403).json({ error: 'Permissão insuficiente' });
    }

    const items = await collectZipItems(folder, req.user);
    if (items.length === 0) {
      return res.status(404).json({ error: 'Esta pasta não possui arquivos para baixar' });
    }

    const zipName = `${sanitizeFilename(folder.name) || 'pasta'}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      log.error({ err }, 'zip_stream_error');
      res.destroy(err);
    });
    archive.pipe(res);

    for (const item of items) {
      try {
        const stream = await getObjectStream(item.storageKey);
        archive.append(stream, { name: item.path });
      } catch (err) {
        log.error({ err, key: item.storageKey }, 'zip_item_failed');
      }
    }

    await archive.finalize();
    await audit(req, 'DOWNLOAD_ZIP', 'Folder', folder.id, { name: folder.name, fileCount: items.length });
  })
);

function sanitizeFilename(name) {
  return String(name).replace(/[^a-zA-Z0-9._ -]/g, '_').trim();
}

// Percorre recursivamente uma pasta coletando os arquivos para o .zip,
// pulando qualquer subpasta que não seja visível ao usuário (a subárvore
// inteira fica de fora, não só o próprio item).
async function collectZipItems(rootFolder, user) {
  const items = [];

  async function walk(folder, prefix) {
    const docs = await prisma.document.findMany({ where: { folderId: folder.id } });
    for (const d of docs) {
      const ext = d.originalName.includes('.') ? `.${d.originalName.split('.').pop()}` : '';
      items.push({ storageKey: d.storageKey, path: `${prefix}${sanitizeFilename(d.name)}${ext}` });
    }

    const children = await prisma.folder.findMany({ where: { parentId: folder.id } });
    for (const child of children) {
      if (!isFolderVisible(user, child)) continue;
      await walk(child, `${prefix}${sanitizeFilename(child.name)}/`);
    }
  }

  await walk(rootFolder, '');
  return items;
}

app.delete(
  '/api/folders/:id',
  auth,
  role('ADMIN'),
  asyncRoute(async (req, res) => {
    const [childCount, docCount] = await Promise.all([
      prisma.folder.count({ where: { parentId: req.params.id } }),
      prisma.document.count({ where: { folderId: req.params.id } }),
    ]);
    if (childCount > 0 || docCount > 0) {
      return res.status(400).json({ error: 'A pasta possui subpastas ou arquivos e não pode ser removida' });
    }

    const folder = await prisma.folder.delete({ where: { id: req.params.id } });
    await audit(req, 'DELETE_FOLDER', 'Folder', folder.id, { name: folder.name });
    res.status(204).end();
  })
);

// =============================================================================
// Rotas - Documentos
// =============================================================================

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.ms-excel',
  'image/jpeg',
  'image/png',
];

app.get(
  '/api/documents',
  auth,
  asyncRoute(async (req, res) => {
    const q = String(req.query.q || '');
    const folderId = String(req.query.folder || '');
    const category = String(req.query.category || '').toUpperCase();

    const textFilter = {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { originalName: { contains: q, mode: 'insensitive' } },
      ],
    };

    if (folderId) {
      const folder = await prisma.folder.findUnique({ where: { id: folderId } });
      if (!folder) return res.status(404).json({ error: 'Pasta não encontrada' });
      if (!(await isFolderChainVisible(prisma, req.user, folder))) {
        return res.status(403).json({ error: 'Permissão insuficiente' });
      }

      const docs = await prisma.document.findMany({
        where: { folderId, ...textFilter },
        include: { folder: { select: { id: true, name: true } }, owner: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      return res.json(docs);
    }

    // Sem pasta específica: filtra pelo conjunto de pastas que o usuário
    // realmente pode acessar (evita vazar arquivos de pastas restritas).
    const allFolders = await prisma.folder.findMany({
      where: CATEGORIES.includes(category) ? { category } : {},
    });
    const byId = new Map(allFolders.map((f) => [f.id, f]));

    function chainVisible(folder) {
      let cur = folder;
      while (cur) {
        if (!isFolderVisible(req.user, cur)) return false;
        if (!cur.parentId) return true;
        cur = byId.get(cur.parentId);
        if (!cur) return false;
      }
      return true;
    }

    const visibleFolderIds = allFolders.filter(chainVisible).map((f) => f.id);

    const docs = await prisma.document.findMany({
      where: { folderId: { in: visibleFolderIds }, ...textFilter },
      include: { folder: { select: { id: true, name: true } }, owner: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(docs);
  })
);

app.post(
  '/api/documents/upload-url',
  auth,
  role('ADMIN', 'TEACHER', 'STAFF'),
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        name: z.string().min(1).max(180),
        originalName: z.string().min(1).max(255),
        mimeType: z.string(),
        sizeBytes: z.number().int().positive().max(25 * 1024 * 1024),
        folderId: z.string().uuid(),
      })
      .parse(req.body);

    if (!ALLOWED_MIME_TYPES.includes(b.mimeType)) {
      return res.status(400).json({ error: 'Tipo de arquivo não permitido' });
    }

    const folder = await prisma.folder.findUnique({ where: { id: b.folderId } });
    if (!folder) return res.status(404).json({ error: 'Pasta não encontrada' });
    if (!(await isFolderChainVisible(prisma, req.user, folder))) {
      return res.status(403).json({ error: 'Permissão insuficiente para enviar arquivos nesta pasta' });
    }

    const safeName = b.originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150);
    const key = `documents/${req.user.sub}/${crypto.randomUUID()}-${safeName}`;

    const url = await uploadUrl(key, b.mimeType, publicOriginFromRequest(req));

    const doc = await prisma.document.create({
      data: { ...b, storageKey: key, ownerId: req.user.sub, ownerRole: req.user.role },
    });

    await audit(req, 'UPLOAD', 'Document', doc.id, { name: b.name, folderId: b.folderId, folderName: folder.name, category: folder.category });

    res.status(201).json({ document: doc, uploadUrl: url });
  })
);

app.get(
  '/api/documents/:id/download-url',
  auth,
  asyncRoute(async (req, res) => {
    const d = await prisma.document.findUnique({ where: { id: req.params.id }, include: { folder: true } });
    if (!d) return res.status(404).json({ error: 'Arquivo não encontrado' });
    if (!(await isFolderChainVisible(prisma, req.user, d.folder))) {
      return res.status(403).json({ error: 'Permissão insuficiente' });
    }

    await audit(req, 'DOWNLOAD', 'Document', d.id, { name: d.name, folderName: d.folder.name });
    res.json({ url: await downloadUrl(d.storageKey, publicOriginFromRequest(req)) });
  })
);

// Renomear arquivo: quem enviou ou hierarquia superior
app.patch(
  '/api/documents/:id',
  auth,
  asyncRoute(async (req, res) => {
    const { name } = z.object({ name: z.string().min(1).max(180) }).parse(req.body);

    const doc = await prisma.document.findUnique({ where: { id: req.params.id }, include: { folder: true } });
    if (!doc) return res.status(404).json({ error: 'Arquivo não encontrado' });
    if (!(await isFolderChainVisible(prisma, req.user, doc.folder))) {
      return res.status(403).json({ error: 'Permissão insuficiente' });
    }

    const allowed = doc.ownerId === req.user.sub || isSuperior(req.user.role, doc.ownerRole);
    if (!allowed) {
      return res.status(403).json({ error: 'Somente quem enviou o arquivo ou hierarquia superior pode renomeá-lo' });
    }

    const updated = await prisma.document.update({ where: { id: doc.id }, data: { name } });
    await audit(req, 'RENAME_DOCUMENT', 'Document', doc.id, { from: doc.name, to: name, folderName: doc.folder.name });
    res.json(updated);
  })
);

app.delete(
  '/api/documents/:id',
  auth,
  role('ADMIN'),
  asyncRoute(async (req, res) => {
    const d = await prisma.document.findUnique({ where: { id: req.params.id }, include: { folder: true } });
    if (!d) return res.status(404).json({ error: 'Arquivo não encontrado' });

    await deleteObject(d.storageKey).catch((err) => log.error({ err }, 'delete_object_failed'));
    await prisma.document.delete({ where: { id: d.id } });

    await audit(req, 'DELETE', 'Document', d.id, { name: d.name, folderName: d.folder?.name });
    res.status(204).end();
  })
);

// =============================================================================
// Rotas - Logs de auditoria
// =============================================================================

const ACTION_LABELS_PT = {
  LOGIN: 'Login',
  UPLOAD: 'Envio de arquivo',
  DOWNLOAD: 'Download de arquivo',
  DOWNLOAD_ZIP: 'Download de pasta (.zip)',
  RENAME_DOCUMENT: 'Renomear arquivo',
  DELETE: 'Exclusão de arquivo',
  CREATE_FOLDER: 'Criação de pasta',
  CREATE_SUBFOLDER: 'Criação de subpasta',
  UPDATE_FOLDER: 'Alteração de visibilidade',
  RENAME_FOLDER: 'Renomeação de pasta',
  DELETE_FOLDER: 'Remoção de pasta',
  CREATE_USER: 'Cadastro de usuário',
  UPDATE_USER: 'Atualização de usuário',
  APPROVE_USER: 'Aprovação de usuário',
  REJECT_USER: 'Rejeição de cadastro',
  PASSWORD_RESET_REQUEST: 'Solicitação de redefinição de senha',
  RESET_PASSWORD: 'Redefinição de senha',
  UPDATE_AVATAR: 'Atualização de foto de perfil',
};

const ROLE_LABELS_PT = { ADMIN: 'Administrador(a)', TEACHER: 'Professor(a)', STAFF: 'Secretaria' };

// Monta uma descrição legível (o que exatamente foi feito, em qual
// pasta/arquivo/usuário) a partir dos metadados guardados no log — usada na
// exportação para dar contexto completo sem precisar decifrar UUIDs.
function describeAuditLog(l) {
  const m = l.metadata || {};
  switch (l.action) {
    case 'CREATE_FOLDER':
      return `"${m.name || ''}"`;
    case 'CREATE_SUBFOLDER':
      return m.parentName ? `"${m.name || ''}" dentro de "${m.parentName}"` : `"${m.name || ''}"`;
    case 'RENAME_FOLDER':
      return `"${m.rename?.from || ''}" -> "${m.rename?.to || ''}"`;
    case 'UPDATE_FOLDER':
      return `pasta "${m.folderName || ''}"`;
    case 'DELETE_FOLDER':
      return `"${m.name || ''}"`;
    case 'DOWNLOAD_ZIP':
      return `"${m.name || ''}" (${m.fileCount ?? 0} arquivo(s))`;
    case 'UPLOAD':
      return `"${m.name || ''}"${m.folderName ? ` em "${m.folderName}"` : ''}`;
    case 'DOWNLOAD':
    case 'DELETE':
      return `"${m.name || ''}"${m.folderName ? ` (${m.folderName})` : ''}`;
    case 'RENAME_DOCUMENT':
      return `"${m.from || ''}" -> "${m.to || ''}"`;
    case 'CREATE_USER':
      return `${m.username || ''}${m.role ? ` (${ROLE_LABELS_PT[m.role] || m.role})` : ''}`;
    case 'UPDATE_USER':
    case 'APPROVE_USER': {
      const who = m.targetName || m.targetUsername || '';
      const parts = [];
      if (m.role) parts.push(`perfil -> ${ROLE_LABELS_PT[m.role] || m.role}`);
      if (m.active === true) parts.push('aprovado');
      if (m.active === false) parts.push('desativado');
      return `${who}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'REJECT_USER':
      return m.username || '';
    case 'PASSWORD_RESET_REQUEST':
    case 'RESET_PASSWORD':
      return `${m.targetName || ''}${m.targetUsername ? ` (${m.targetUsername})` : ''}`;
    default:
      return m.name || '';
  }
}

// Monta a consulta de logs com os filtros aplicados no banco (ação e período)
// e o filtro de texto livre aplicado em memória (busca em usuário, ação,
// entidade, id do registro e metadados) — suficiente para o volume de uma
// escola, sem precisar de busca full-text no Postgres.
async function queryAuditLogs(query, limit) {
  const where = {};
  if (query.action) where.action = String(query.action);
  if (query.from || query.to) {
    where.createdAt = {};
    if (query.from) where.createdAt.gte = new Date(`${query.from}T00:00:00`);
    if (query.to) where.createdAt.lte = new Date(`${query.to}T23:59:59.999`);
  }

  let logs = await prisma.auditLog.findMany({
    where,
    include: { user: { select: { name: true, username: true } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  if (query.q) {
    const q = String(query.q).toLowerCase();
    logs = logs.filter((l) =>
      [l.user?.name, l.user?.username, ACTION_LABELS_PT[l.action] || l.action, l.entity, l.entityId, JSON.stringify(l.metadata || {})]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q))
    );
  }

  return logs;
}

app.get(
  '/api/audit-logs',
  auth,
  role('ADMIN'),
  asyncRoute(async (req, res) => {
    const take = Math.min(Number(req.query.take) || 100, 500);
    // Busca um lote maior do banco para que o filtro de texto (aplicado em
    // memória) não fique restrito apenas às últimas `take` linhas.
    const pool = await queryAuditLogs(req.query, 1000);
    res.json(pool.slice(0, take));
  })
);

app.get(
  '/api/audit-logs/export',
  auth,
  role('ADMIN'),
  asyncRoute(async (req, res) => {
    const format = String(req.query.format || 'csv').toLowerCase();
    if (!['csv', 'xlsx'].includes(format)) return res.status(400).json({ error: 'Formato inválido' });

    const logs = await queryAuditLogs(req.query, 5000);
    const rows = logs.map((l) => ({
      atividade: ACTION_LABELS_PT[l.action] || l.action,
      entidade: l.entity,
      entidadeId: l.entityId || '',
      detalhes: describeAuditLog(l),
      usuario: l.user?.username || 'Sistema',
      nomeCompleto: l.user?.name || '',
      dataHora: l.createdAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      ip: l.ip || '',
    }));

    const timestamp = new Date().toISOString().slice(0, 10);

    if (format === 'csv') {
      const headers = ['Tipo de atividade', 'Entidade', 'ID do registro', 'Detalhes', 'Nome de usuário', 'Nome completo', 'Data/Hora', 'IP'];
      const esc = (v) => {
        const s = String(v ?? '');
        return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [headers.map(esc).join(';')];
      for (const r of rows) {
        lines.push([r.atividade, r.entidade, r.entidadeId, r.detalhes, r.usuario, r.nomeCompleto, r.dataHora, r.ip].map(esc).join(';'));
      }
      // BOM + ";" como separador: compatibilidade com Excel em pt-BR.
      const csv = '\uFEFF' + lines.join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="logs-epasesc-${timestamp}.csv"`);
      return res.send(csv);
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Logs');
    ws.columns = [
      { header: 'Tipo de atividade', key: 'atividade', width: 26 },
      { header: 'Entidade', key: 'entidade', width: 12 },
      { header: 'ID do registro', key: 'entidadeId', width: 38 },
      { header: 'Detalhes', key: 'detalhes', width: 42 },
      { header: 'Nome de usuário', key: 'usuario', width: 22 },
      { header: 'Nome completo', key: 'nomeCompleto', width: 30 },
      { header: 'Data/Hora', key: 'dataHora', width: 20 },
      { header: 'IP', key: 'ip', width: 16 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.addRows(rows);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="logs-epasesc-${timestamp}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  })
);

// =============================================================================
// 404 + erro
// =============================================================================

app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

app.use((err, req, res, next) => {
  if (err.name === 'ZodError') return res.status(400).json({ error: 'Dados inválidos', details: err.issues });
  if (err.code === 'P2025') return res.status(404).json({ error: 'Registro não encontrado' });
  log.error({ err }, 'request_error');
  res.status(500).json({ error: 'Erro interno' });
});

// =============================================================================
// Inicialização
// =============================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log.info(`E-Pasesc API na porta ${PORT}`));

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
