// =============================================================================
// Hierarquia de papéis
// =============================================================================
// ADMIN > STAFF (Secretaria) > TEACHER (Professor)

export const ROLE_RANK = { TEACHER: 1, STAFF: 2, ADMIN: 3 };

export function isSuperior(actingRole, targetRole) {
  return ROLE_RANK[actingRole] > ROLE_RANK[targetRole];
}

// =============================================================================
// Visibilidade de pastas
// =============================================================================
// Regras:
// - ADMIN sempre vê tudo.
// - Quem criou a pasta sempre a vê.
// - STAFF sempre vê pastas criadas por TEACHER e por outro STAFF; para pastas
//   criadas por ADMIN, depende da flag visibleToStaff.
// - TEACHER depende da flag visibleToTeachers, seja qual for o criador.

export function isFolderVisible(user, folder) {
  if (user.role === 'ADMIN') return true;
  if (folder.creatorId === user.sub) return true;

  if (user.role === 'STAFF') {
    if (folder.creatorRole === 'ADMIN') return folder.visibleToStaff;
    return true;
  }

  if (user.role === 'TEACHER') {
    return folder.visibleToTeachers;
  }

  return false;
}

// Verifica se a pasta E todos os seus ancestrais são visíveis ao usuário —
// evita que alguém acesse uma subpasta "pulando" uma pasta pai bloqueada.
export async function isFolderChainVisible(prisma, user, folder) {
  let current = folder;
  while (current) {
    if (!isFolderVisible(user, current)) return false;
    if (!current.parentId) return true;
    current = await prisma.folder.findUnique({ where: { id: current.parentId } });
    if (!current) return false;
  }
  return true;
}

// Resolve os valores finais das flags de visibilidade na criação/edição de
// uma pasta, aplicando as regras de quem pode escolher o quê:
// - TEACHER: staff/admin sempre veem (forçado); só escolhe se outros
//   professores veem.
// - STAFF: staff/admin sempre veem (forçado); só escolhe se professores veem.
// - ADMIN: escolhe livremente as duas flags (staff e professores).
export function resolveFolderVisibilityFlags(creatorRole, input = {}) {
  if (creatorRole === 'ADMIN') {
    return {
      visibleToStaff: input.visibleToStaff ?? true,
      visibleToTeachers: input.visibleToTeachers ?? true,
    };
  }
  // TEACHER e STAFF: staff/admin sempre têm acesso.
  return {
    visibleToStaff: true,
    visibleToTeachers: input.visibleToTeachers ?? true,
  };
}
