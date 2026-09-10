const api = '/api';
let currentUser = null;

const ROLE_RANK = { TEACHER: 1, STAFF: 2, ADMIN: 3 };
const ROLE_LABEL = { ADMIN: 'Administrador(a)', TEACHER: 'Professor(a)', STAFF: 'Secretaria' };
const CATEGORY_LABEL = { TURMA: 'Pedagógico', SECRETARIA: 'Secretaria / Administração' };

// Guarda a última lista de pastas raiz carregada, para a busca local funcionar
// sem precisar refazer a requisição a cada tecla digitada.
let browserRootFolders = [];

// Estado do navegador de pastas (reaproveitado por Pedagógico e Secretaria)
let browserCategory = 'TURMA';
let browserFolderId = null;
let browserFolderData = null;

// =============================================================================
// Helpers
// =============================================================================

const $ = (id) => document.getElementById(id);

function authMsg(t, isError = true) {
  const el = $('authMsg');
  el.textContent = t || '';
  el.classList.toggle('error', isError);
}

function appMsg(t, isError = false) {
  const el = $('appMsg');
  el.textContent = t || '';
  el.classList.toggle('error', isError);
  if (t) setTimeout(() => { if (el.textContent === t) el.textContent = ''; }, 4000);
}

async function request(path, options = {}) {
  const r = await fetch(api + path, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!r.ok) {
    let error = 'Erro';
    try { error = (await r.json()).error || error; } catch { /* corpo vazio */ }
    throw new Error(error);
  }
  return r.status === 204 ? null : r.json();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatDate(iso) { return new Date(iso).toLocaleString('pt-BR'); }

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExt(originalName) {
  const parts = String(originalName).split('.');
  return parts.length > 1 ? parts.pop().toUpperCase() : '';
}

function fileIcon(mimeType) {
  if (mimeType === 'application/pdf') return '📕';
  if (mimeType.includes('wordprocessingml') || mimeType === 'application/msword') return '📝';
  if (mimeType.includes('spreadsheetml') || mimeType === 'application/vnd.ms-excel') return '📊';
  if (mimeType.startsWith('image/')) return '🖼️';
  return '📁';
}

function roleLabel(role) { return ROLE_LABEL[role] || role; }

// =============================================================================
// Modal genérico (criar/editar pasta, criar subpasta, enviar arquivo)
// =============================================================================

function openModal(html) {
  $('modalContent').innerHTML = html;
  $('modalOverlay').hidden = false;
  document.body.classList.add('modal-open');
}

function closeModal() {
  $('modalOverlay').hidden = true;
  $('modalContent').innerHTML = '';
  document.body.classList.remove('modal-open');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modalOverlay').hidden) closeModal();
});

// Botão de "olho": alterna o campo de senha entre oculto e visível.
function togglePassword(inputId, btn) {
  const input = $(inputId);
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.textContent = showing ? '👁️' : '🙈';
  btn.setAttribute('aria-label', showing ? 'Mostrar senha' : 'Ocultar senha');
}

// =============================================================================
// Landing page ↔ Autenticação
// =============================================================================

function showLanding() {
  $('landingScreen').hidden = false;
  $('authScreen').hidden = true;
}

function goToAuth(tab) {
  $('landingScreen').hidden = true;
  $('authScreen').hidden = false;
  showAuthTab(tab);
}

function canRenameDoc(d) {
  return currentUser && (d.ownerId === currentUser.id || ROLE_RANK[currentUser.role] > ROLE_RANK[d.ownerRole]);
}

function canManageFolder(f) {
  return currentUser && (f.creatorId === currentUser.id || ROLE_RANK[currentUser.role] > ROLE_RANK[f.creatorRole]);
}

// =============================================================================
// Autenticação
// =============================================================================

let isBootstrapMode = false;

async function checkSetupStatus() {
  try {
    const { needsSetup } = await request('/auth/setup-status');
    isBootstrapMode = needsSetup;
    if (needsSetup) {
      $('landingScreen').hidden = true;
      $('authScreen').hidden = false;
      $('authTabs').hidden = true;
      $('registerHint').textContent =
        'Nenhum administrador foi encontrado. Cadastre o primeiro administrador do sistema para começar.';
      showAuthTab('register', true);
    } else {
      showLanding();
    }
  } catch {
    // Se a checagem falhar, segue com a landing page padrão (mais seguro
    // do que arriscar mostrar o formulário de bootstrap incorretamente).
    showLanding();
  }
}

function showAuthTab(tab, forced = false) {
  document.querySelectorAll('#authTabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('loginForm').hidden = tab !== 'login';
  $('registerForm').hidden = tab !== 'register';
  // Independente de como showAuthTab foi chamado (clique em aba, botão da
  // landing page, etc.), o modo bootstrap sempre esconde o seletor de
  // perfil — o primeiro usuário só pode ser administrador.
  $('regRoleWrap').hidden = forced || isBootstrapMode;
  authMsg('');
}

document.querySelectorAll('#authTabs .tab-btn').forEach((b) => b.addEventListener('click', () => showAuthTab(b.dataset.tab)));

async function handleLogin() {
  const username = $('loginUsername').value.trim();
  const password = $('loginPassword').value;
  if (!username || !password) return authMsg('Preencha o nome de usuário e a senha.');
  try {
    await request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    await enterApp();
  } catch (e) { authMsg(e.message); }
}

function openForgotPasswordModal() {
  openModal(`
    <h3>Esqueci minha senha</h3>
    <p class="hint">Informe seu nome de usuário. A secretaria ou administração vai receber o pedido e redefinir sua senha.</p>
    <div class="modal-form">
      <label>Nome de usuário
        <input id="modalForgotUsername" class="field-lg" placeholder="Ex: MariaPereira" autofocus>
      </label>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="handleForgotPassword()">Enviar solicitação</button>
      </div>
    </div>`);
}

async function handleForgotPassword() {
  const username = $('modalForgotUsername').value.trim();
  if (!username) return appMsg('Informe seu nome de usuário.', true);
  try {
    await request('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ username }) });
    closeModal();
    appMsg('Solicitação enviada! A secretaria ou administração vai redefinir sua senha em breve.');
  } catch (e) { appMsg(e.message, true); }
}

async function handleRegister() {
  const body = {
    name: $('regName').value.trim(),
    password: $('regPassword').value,
    confirmPassword: $('regConfirmPassword').value,
    role: $('regRole').value,
  };
  if (!body.name || body.password.length < 10) {
    return authMsg('Preencha o nome e uma senha com ao menos 10 caracteres.');
  }
  if (body.password !== body.confirmPassword) {
    return authMsg('As senhas digitadas não são iguais.');
  }
  try {
    const created = await request('/auth/register', { method: 'POST', body: JSON.stringify(body) });
    $('registerForm').reset();
    $('authTabs').hidden = false;
    showAuthTab('login');
    openUsernameModal(created.username, created.active);
  } catch (e) { authMsg(e.message); }
}

// Mostra o nome de usuário gerado num pop-up (em vez de só um texto pequeno)
// — é a única forma de a pessoa entrar depois, então não pode passar
// despercebido.
function openUsernameModal(username, isActive, forSelf = true) {
  const intro = forSelf
    ? `Anote seu nome de usuário — você vai precisar dele para entrar${isActive ? '' : ', assim que a secretaria ou administração aprovar seu acesso'}.`
    : `Repasse este nome de usuário para a pessoa cadastrada — ela vai precisar dele para entrar${isActive ? '' : ', assim que o cadastro for aprovado'}.`;
  openModal(`
    <h3>${isActive ? 'Cadastro concluído!' : 'Cadastro enviado!'}</h3>
    <p class="hint">${intro}</p>
    <div class="username-reveal">
      <span id="revealedUsername">${escapeHtml(username)}</span>
      <button type="button" class="btn btn-secondary btn-sm" onclick="handleCopyUsername('${username}')">📋 Copiar</button>
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary" onclick="closeModal()">Entendi, anotei</button>
    </div>`);
}

async function handleCopyUsername(username) {
  try {
    await navigator.clipboard.writeText(username);
    appMsg('Nome de usuário copiado!');
  } catch {
    appMsg('Não foi possível copiar automaticamente — selecione o texto manualmente.', true);
  }
}

async function handleLogout() {
  await request('/auth/logout', { method: 'POST' }).catch(() => {});
  currentUser = null;
  $('appScreen').hidden = true;
  $('loginForm').reset();
  showLanding();
}

async function enterApp() {
  currentUser = await request('/auth/me');
  $('landingScreen').hidden = true;
  $('authScreen').hidden = true;
  $('appScreen').hidden = false;
  $('userName').textContent = currentUser.name;
  $('userRole').textContent = roleLabel(currentUser.role);

  const isAdmin = currentUser.role === 'ADMIN';
  const canManageUsers = isAdmin || currentUser.role === 'STAFF';
  document.querySelectorAll('.admin-only').forEach((el) => { el.hidden = !isAdmin; });
  document.querySelectorAll('.users-nav').forEach((el) => { el.hidden = !canManageUsers; });

  await loadAvatar();
  switchView('documents');
}

// =============================================================================
// Foto de perfil
// =============================================================================

function handleAvatarClick() {
  $('avatarFileInput').click();
}

async function loadAvatar() {
  try {
    const { url } = await request('/auth/avatar-url');
    if (url) {
      $('avatarImg').src = url;
      $('avatarImg').hidden = false;
      $('avatarPlaceholder').hidden = true;
    } else {
      $('avatarImg').hidden = true;
      $('avatarPlaceholder').hidden = false;
    }
  } catch { /* não é crítico — mantém o ícone padrão */ }
}

async function handleAvatarFileSelected(e) {
  const file = e.target.files[0];
  e.target.value = ''; // permite escolher o mesmo arquivo de novo depois, se quiser

  if (!file) return;

  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) return appMsg('Use uma imagem JPG, PNG ou WEBP.', true);
  if (file.size > 5 * 1024 * 1024) return appMsg('A imagem deve ter no máximo 5MB.', true);

  try {
    const { uploadUrl, key } = await request('/auth/avatar/upload-url', {
      method: 'POST',
      body: JSON.stringify({ mimeType: file.type, sizeBytes: file.size }),
    });

    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!put.ok) throw new Error('Falha no envio da imagem ao armazenamento.');

    await request('/auth/avatar', { method: 'PATCH', body: JSON.stringify({ key }) });
    await loadAvatar();
    appMsg('Foto de perfil atualizada!');
  } catch (err) { appMsg(err.message, true); }
}

// =============================================================================
// Navegação entre views
// =============================================================================

document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

function switchView(view) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

  const targetId = view === 'turma' || view === 'secretaria' ? 'view-browser' : `view-${view}`;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === targetId));

  if (view === 'documents') { loadFolderOptions(); loadDocuments(); }
  if (view === 'turma') openBrowser('TURMA');
  if (view === 'secretaria') openBrowser('SECRETARIA');
  if (view === 'users') loadUsers();
  if (view === 'logs') loadAuditLogs();
}

// =============================================================================
// Navegador de pastas (Pedagógico / Secretaria-Administração)
// =============================================================================

async function openBrowser(category) {
  browserCategory = category;
  browserFolderId = null;
  browserFolderData = null;
  $('browserTitle').textContent = CATEGORY_LABEL[category];
  await loadBrowserRoot();
}

async function loadBrowserRoot() {
  try {
    const roots = await request(`/folders?category=${browserCategory}`);
    browserRootFolders = roots;
    browserFolderId = null;
    browserFolderData = null;
    $('folderSearch').value = '';
    hideEl('zipBtn');
    hideEl('editFolderBtn');
    renderBreadcrumb([]);
    renderRootCreateButton();
    hideEl('createSubfolderBtn');
    hideEl('folderDocsHeader');
    $('browserDocs').innerHTML = '';
    showEl('folderSubsectionHeader');
    $('folderSubsectionHeader').querySelector('h3').textContent =
      browserCategory === 'TURMA' ? 'Pedagógico' : 'Pastas de Secretaria/Administração';
    renderFolderCards(roots, $('browserFolders'), true);
  } catch (e) { appMsg(e.message, true); }
}

function renderRootCreateButton() {
  const isTeacher = currentUser?.role === 'TEACHER';
  // Professor só pode criar pasta raiz em Pedagógico (Turma), nunca em
  // Secretaria/Administração.
  const canCreateRoot =
    currentUser && (['STAFF', 'ADMIN'].includes(currentUser.role) || (isTeacher && browserCategory === 'TURMA'));
  $('rootCreateBtn').hidden = !canCreateRoot;
}

function openCreateRootFolderModal() {
  const visHtml = currentUser?.role === 'ADMIN' ? visibilityCheckboxes('modalRootVis') : visibilityCheckboxesSimple('modalRootVis');
  openModal(`
    <h3>Nova pasta em ${escapeHtml(CATEGORY_LABEL[browserCategory])}</h3>
    <div class="modal-form">
      <label>Nome da pasta
        <input id="modalRootFolderName" class="field-lg" placeholder="Ex: Turma Jardim II" autofocus>
      </label>
      <div class="visibility-box">${visHtml}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="handleCreateRootFolder()">Criar pasta</button>
      </div>
    </div>`);
}

async function handleCreateRootFolder() {
  const name = $('modalRootFolderName').value.trim();
  if (!name) return appMsg('Informe um nome para a pasta.', true);

  const body = { name, category: browserCategory, parentId: null };
  Object.assign(body, readVisibilityCheckboxes('modalRootVis'));

  try {
    await request('/folders', { method: 'POST', body: JSON.stringify(body) });
    closeModal();
    appMsg('Pasta criada com sucesso!');
    await loadBrowserRoot();
  } catch (e) { appMsg(e.message, true); }
}

async function openFolder(id) {
  try {
    browserFolderData = await request(`/folders/${id}`);
    browserFolderId = id;
    renderFolderDetail();
  } catch (e) { appMsg(e.message, true); }
}

// Volta para a lista raiz ou recarrega a pasta atual — usado depois de
// qualquer ação feita a partir de um modal (criar, editar, enviar arquivo).
async function refreshBrowserView() {
  if (browserFolderId) await openFolder(browserFolderId);
  else await loadBrowserRoot();
}

function renderFolderDetail() {
  const { folder, breadcrumb, children, documents } = browserFolderData;

  $('folderSearch').value = '';
  showEl('zipBtn');
  hideEl('rootCreateBtn');
  renderBreadcrumb(breadcrumb);

  if (canManageFolder(folder)) showEl('editFolderBtn'); else hideEl('editFolderBtn');

  showEl('folderSubsectionHeader');
  $('folderSubsectionHeader').querySelector('h3').textContent = 'Subpastas';
  showEl('createSubfolderBtn');
  renderFolderCards(children, $('browserFolders'), false);

  showEl('folderDocsHeader');
  renderDocsList(documents, $('browserDocs'), true);
}

function renderBreadcrumb(chain) {
  const root = `<button class="crumb" onclick="loadBrowserRoot()">${CATEGORY_LABEL[browserCategory]}</button>`;
  const rest = chain.map((c) => `<span class="crumb-sep">/</span><button class="crumb" onclick="openFolder('${c.id}')">${escapeHtml(c.name)}</button>`).join('');
  $('breadcrumb').innerHTML = root + rest;
}

function visibilityCheckboxes(prefix) {
  return `
    <label class="visibility-option"><input type="checkbox" id="${prefix}Staff" checked><span>Visível para a secretaria</span></label>
    <label class="visibility-option"><input type="checkbox" id="${prefix}Teachers" checked><span>Visível para professores</span></label>`;
}

function visibilityCheckboxesSimple(prefix) {
  return `<label class="visibility-option"><input type="checkbox" id="${prefix}Teachers" checked><span>Visível para outros professores</span></label>`;
}

function readVisibilityCheckboxes(prefix) {
  const staffEl = $(`${prefix}Staff`);
  const teachersEl = $(`${prefix}Teachers`);
  const body = {};
  if (teachersEl) body.visibleToTeachers = teachersEl.checked;
  if (staffEl) body.visibleToStaff = staffEl.checked;
  return body;
}

// Acha uma pasta já carregada em tela pelo id — evita uma nova requisição só
// para abrir o modal de edição a partir de um card da listagem.
function findFolderById(id) {
  const pool = browserFolderId ? browserFolderData?.children : browserRootFolders;
  return (pool || []).find((f) => f.id === id);
}

function openEditFolderModal(folder) {
  if (!folder) return;
  const showStaffToggle = folder.creatorRole === 'ADMIN';
  openModal(`
    <h3>Editar pasta</h3>
    <div class="modal-form">
      <label>Nome da pasta
        <input id="modalEditFolderName" class="field-lg" value="${escapeHtml(folder.name)}" autofocus>
      </label>
      <div class="visibility-box">
        ${showStaffToggle ? `<label class="visibility-option"><input type="checkbox" id="modalEditVisStaff" ${folder.visibleToStaff ? 'checked' : ''}><span>Visível para a secretaria</span></label>` : ''}
        <label class="visibility-option"><input type="checkbox" id="modalEditVisTeachers" ${folder.visibleToTeachers ? 'checked' : ''}><span>Visível para professores</span></label>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="handleUpdateFolder('${folder.id}')">Salvar alterações</button>
      </div>
    </div>`);
}

async function handleUpdateFolder(id) {
  const body = {};
  const nameEl = $('modalEditFolderName');
  if (nameEl && nameEl.value.trim()) body.name = nameEl.value.trim();
  const staffEl = $('modalEditVisStaff');
  if (staffEl) body.visibleToStaff = staffEl.checked;
  const teachersEl = $('modalEditVisTeachers');
  if (teachersEl) body.visibleToTeachers = teachersEl.checked;

  try {
    await request(`/folders/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    closeModal();
    appMsg('Pasta atualizada.');
    await refreshBrowserView();
  } catch (e) { appMsg(e.message, true); }
}

function openCreateSubfolderModal() {
  const visHtml = currentUser?.role === 'ADMIN' ? visibilityCheckboxes('modalSubVis') : visibilityCheckboxesSimple('modalSubVis');
  openModal(`
    <h3>Nova subpasta</h3>
    <div class="modal-form">
      <label>Nome da subpasta
        <input id="modalSubfolderName" class="field-lg" placeholder="Ex: Matemática" autofocus>
      </label>
      <div class="visibility-box">${visHtml}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="handleCreateSubfolder()">Criar subpasta</button>
      </div>
    </div>`);
}

async function handleCreateSubfolder() {
  const name = $('modalSubfolderName').value.trim();
  if (!name) return appMsg('Informe um nome para a subpasta.', true);

  const body = { name, parentId: browserFolderId };
  Object.assign(body, readVisibilityCheckboxes('modalSubVis'));

  try {
    await request('/folders', { method: 'POST', body: JSON.stringify(body) });
    closeModal();
    appMsg('Subpasta criada com sucesso!');
    await openFolder(browserFolderId);
  } catch (e) { appMsg(e.message, true); }
}

function renderFolderCards(folders, container, isRoot) {
  container.innerHTML = folders.length
    ? folders.map((f) => `
        <div class="list-item folder-item" onclick="openFolder('${f.id}')">
          <div>
            <strong>🗂️ ${escapeHtml(f.name)}</strong>
            <small>${f._count.children} subpasta(s) · ${f._count.documents} arquivo(s) · criado por ${escapeHtml(f.creator?.name || '')}</small>
          </div>
          <div class="actions">
            ${canManageFolder(f) ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); openEditFolderModal(findFolderById('${f.id}'))" title="Renomear ou alterar visibilidade">✏️ Editar</button>` : ''}
            ${currentUser?.role === 'ADMIN' ? `<button class="btn btn-danger-ghost btn-sm" onclick="event.stopPropagation(); handleDeleteFolder('${f.id}', ${isRoot})">Remover</button>` : ''}
          </div>
        </div>`).join('')
    : `<p class="empty">Nenhuma ${isRoot ? 'pasta' : 'subpasta'} ${isRoot ? 'cadastrada' : 'criada'} ainda.</p>`;
}

async function handleDeleteFolder(id, isRoot) {
  if (!confirm('Remover esta pasta? Só é possível remover pastas vazias (sem subpastas ou arquivos).')) return;
  try {
    await request(`/folders/${id}`, { method: 'DELETE' });
    appMsg('Pasta removida.');
    if (isRoot) await loadBrowserRoot();
    else await openFolder(browserFolderId);
  } catch (e) { appMsg(e.message, true); }
}

function openUploadModal() {
  openModal(`
    <h3>Adicionar arquivo</h3>
    <p class="hint">Tipos aceitos: PDF, Word, Excel, JPG e PNG · tamanho máximo 25MB.</p>
    <div class="modal-form">
      <label>Nome de exibição (opcional)
        <input id="modalUploadName" class="field-lg" placeholder="Deixe em branco para usar o nome do arquivo" autofocus>
      </label>
      <label>Arquivo
        <input id="modalUploadFile" type="file">
      </label>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="handleUploadInBrowser()">Enviar arquivo</button>
      </div>
    </div>`);
}

async function handleUploadInBrowser() {
  const file = $('modalUploadFile').files[0];
  if (!file) return appMsg('Selecione um arquivo.', true);
  try {
    await uploadFile(file, $('modalUploadName').value.trim() || file.name, browserFolderId);
    closeModal();
    appMsg('Arquivo enviado com sucesso!');
    await openFolder(browserFolderId);
  } catch (e) { appMsg(e.message, true); }
}

// Busca local (sem requisição nova) entre as pastas/arquivos já carregados
// na tela atual do navegador — funciona tanto na listagem raiz (Pedagógico/
// Secretaria) quanto dentro de uma pasta aberta.
function filterFolderView() {
  const q = $('folderSearch').value.trim().toLowerCase();

  if (browserFolderId && browserFolderData) {
    const { children, documents } = browserFolderData;
    const filteredFolders = q ? children.filter((f) => f.name.toLowerCase().includes(q)) : children;
    const filteredDocs = q
      ? documents.filter((d) => d.name.toLowerCase().includes(q) || d.originalName.toLowerCase().includes(q))
      : documents;
    renderFolderCards(filteredFolders, $('browserFolders'), false);
    renderDocsList(filteredDocs, $('browserDocs'), true);
  } else {
    const filtered = q ? browserRootFolders.filter((f) => f.name.toLowerCase().includes(q)) : browserRootFolders;
    renderFolderCards(filtered, $('browserFolders'), true);
  }
}

// Baixa a pasta/subpasta inteira como .zip. Usa fetch + blob (em vez de
// simplesmente navegar para a URL) para conseguir mostrar uma mensagem de
// erro amigável caso a pasta esteja vazia, sem sair da aplicação.
async function handleDownloadZip(id) {
  if (!id) return;
  try {
    const res = await fetch(`${api}/folders/${id}/download-zip`, { credentials: 'include' });
    if (!res.ok) {
      let msg = 'Não foi possível gerar o .zip desta pasta.';
      try { msg = (await res.json()).error || msg; } catch { /* corpo vazio */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : 'pasta.zip';

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) { appMsg(e.message, true); }
}

function hideEl(id) { $(id).hidden = true; }
function showEl(id) { $(id).hidden = false; }

// =============================================================================
// Documentos (busca global)
// =============================================================================

async function loadFolderOptions() {
  try {
    const [turmas, secretaria] = await Promise.all([
      request('/folders/flat?category=TURMA'),
      request('/folders/flat?category=SECRETARIA'),
    ]);
    const all = [
      ...turmas.map((f) => ({ ...f, label: `Pedagógico / ${f.path}` })),
      ...secretaria.map((f) => ({ ...f, label: `Secretaria / ${f.path}` })),
    ];
    const opts = all.map((f) => `<option value="${f.id}">${escapeHtml(f.label)}</option>`).join('');
    const current = $('filterFolder').value;
    $('filterFolder').innerHTML = '<option value="">Todas as pastas acessíveis</option>' + opts;
    // Mantém a seleção atual, se ela ainda existir na lista atualizada.
    if (current && [...$('filterFolder').options].some((o) => o.value === current)) {
      $('filterFolder').value = current;
    }
  } catch (e) { appMsg(e.message, true); }
}

async function loadDocuments() {
  try {
    const q = encodeURIComponent($('search').value);
    const folder = encodeURIComponent($('filterFolder').value);
    const docs = await request(`/documents?q=${q}&folder=${folder}`);
    renderDocsList(docs, $('docsList'), false);
  } catch (e) { appMsg(e.message, true); }
}

function renderDocsList(docs, container, compactFolderLabel) {
  container.innerHTML = docs.length
    ? docs.map((d) => `
        <div class="list-item">
          <div class="doc-main">
            <span class="doc-icon">${fileIcon(d.mimeType)}</span>
            <div>
              <strong>${escapeHtml(d.name)} <span class="ext-badge">.${fileExt(d.originalName)}</span></strong>
              <small>${compactFolderLabel ? '' : `${escapeHtml(d.folder.name)} · `}${escapeHtml(d.owner.name)} · ${formatSize(d.sizeBytes)} · ${formatDate(d.createdAt)}</small>
            </div>
          </div>
          <div class="actions">
            ${canRenameDoc(d) ? `<button class="btn btn-ghost" onclick="openRenameDocumentModal('${d.id}', '${escapeHtml(d.name).replace(/'/g, "&#39;")}')">Renomear</button>` : ''}
            <button class="btn btn-secondary" onclick="handleDownload('${d.id}')">Baixar</button>
            ${currentUser?.role === 'ADMIN' ? `<button class="btn btn-danger-ghost" onclick="handleDeleteDocument('${d.id}')">Excluir</button>` : ''}
          </div>
        </div>`).join('')
    : '<p class="empty">Nenhum arquivo encontrado.</p>';
}

async function handleDownload(id) {
  try {
    const { url } = await request(`/documents/${id}/download-url`);
    window.open(url, '_blank');
  } catch (e) { appMsg(e.message, true); }
}

async function uploadFile(file, displayName, folderId) {
  const data = await request('/documents/upload-url', {
    method: 'POST',
    body: JSON.stringify({
      name: displayName,
      originalName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      folderId,
    }),
  });
  const put = await fetch(data.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  if (!put.ok) throw new Error('Falha no envio ao armazenamento.');
}

function openRenameDocumentModal(id, currentName) {
  openModal(`
    <h3>Renomear arquivo</h3>
    <div class="modal-form">
      <label>Nome do arquivo
        <input id="modalRenameDocName" class="field-lg" value="${escapeHtml(currentName)}" autofocus>
      </label>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="handleRenameDocument('${id}')">Salvar novo nome</button>
      </div>
    </div>`);
}

async function handleRenameDocument(id) {
  const name = $('modalRenameDocName').value.trim();
  if (!name) return appMsg('Informe um nome para o arquivo.', true);
  try {
    await request(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    closeModal();
    appMsg('Arquivo renomeado.');
    if ($('view-documents').classList.contains('active')) await loadDocuments();
    else if (browserFolderId) await openFolder(browserFolderId);
  } catch (e) { appMsg(e.message, true); }
}

async function handleDeleteDocument(id) {
  if (!confirm('Excluir este arquivo permanentemente?')) return;
  try {
    await request(`/documents/${id}`, { method: 'DELETE' });
    appMsg('Arquivo excluído.');
    if ($('view-documents').classList.contains('active')) await loadDocuments();
    else if (browserFolderId) await openFolder(browserFolderId);
  } catch (e) { appMsg(e.message, true); }
}

// =============================================================================
// Usuários (administração)
// =============================================================================

async function loadUsers() {
  try {
    const users = await request('/users');
    const isAdmin = currentUser?.role === 'ADMIN';

    // Restringe o seletor de perfil do formulário de cadastro: só ADMIN
    // pode conceder o papel de Administrador(a).
    const roleSelect = $('newUserRole');
    if (roleSelect) {
      const adminOption = roleSelect.querySelector('option[value="ADMIN"]');
      if (adminOption) adminOption.hidden = !isAdmin;
      if (!isAdmin && roleSelect.value === 'ADMIN') roleSelect.value = 'TEACHER';
    }

    $('usersList').innerHTML = users.map((u) => {
      const statusLabel = u.active ? 'Ativo' : 'Pendente de aprovação';
      // Hierarquia: ADMIN gerencia todos; Secretaria só gerencia professores
      // (nunca outra pessoa da secretaria nem administradores) e nunca troca
      // o perfil de ninguém — só um administrador reatribui papéis.
      const canManageThisUser = isAdmin || (currentUser?.role === 'STAFF' && u.role === 'TEACHER');

      const roleControl = isAdmin
        ? `<select onchange="handleChangeRole('${u.id}', this.value)">
            ${['ADMIN', 'TEACHER', 'STAFF'].map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${roleLabel(r)}</option>`).join('')}
          </select>`
        : `<span class="badge-role">${roleLabel(u.role)}</span>`;

      const actionButton = canManageThisUser
        ? `<button class="btn ${u.active ? 'btn-danger-ghost' : 'btn-primary'}" onclick="handleToggleActive('${u.id}', ${!u.active})">
            ${u.active ? 'Desativar' : 'Aprovar'}
          </button>`
        : '';

      const rejectButton = canManageThisUser && !u.active
        ? `<button class="btn btn-danger-ghost" onclick="handleRejectUser('${u.id}', '${escapeHtml(u.name).replace(/'/g, "\\'")}')">Rejeitar</button>`
        : '';

      const resetButton = canManageThisUser
        ? `<button class="btn btn-secondary" onclick="openResetPasswordModal('${u.id}', '${escapeHtml(u.name).replace(/'/g, "\\'")}')">🔑 Redefinir senha</button>`
        : '';

      const resetBadge = u.passwordResetRequested
        ? '<span class="badge-reset-request">🔑 Pediu redefinição de senha</span>'
        : '';

      return `
      <div class="list-item ${u.active ? '' : 'list-item-pending'}">
        <div>
          <strong>${escapeHtml(u.name)}</strong>
          <small>${escapeHtml(u.username)} · ${statusLabel}</small>
          ${resetBadge}
        </div>
        <div class="actions">
          ${roleControl}
          ${actionButton}
          ${rejectButton}
          ${resetButton}
        </div>
      </div>`;
    }).join('');
  } catch (e) { appMsg(e.message, true); }
}

function openResetPasswordModal(id, name) {
  openModal(`
    <h3>Redefinir senha</h3>
    <p class="hint">Defina uma nova senha para <strong>${escapeHtml(name)}</strong>. Combine com a pessoa como ela vai receber essa senha.</p>
    <div class="modal-form">
      <label>Nova senha (mínimo 10 caracteres)
        <div class="password-field">
          <input id="modalResetPassword" type="password" minlength="10" placeholder="Crie uma senha forte" autofocus>
          <button type="button" class="eye-btn" onclick="togglePassword('modalResetPassword', this)" aria-label="Mostrar senha">👁️</button>
        </div>
      </label>
      <label>Confirmar nova senha
        <div class="password-field">
          <input id="modalResetConfirmPassword" type="password" minlength="10" placeholder="Digite a senha novamente">
          <button type="button" class="eye-btn" onclick="togglePassword('modalResetConfirmPassword', this)" aria-label="Mostrar senha">👁️</button>
        </div>
      </label>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="handleResetPassword('${id}')">Salvar nova senha</button>
      </div>
    </div>`);
}

async function handleResetPassword(id) {
  const newPassword = $('modalResetPassword').value;
  const confirmPassword = $('modalResetConfirmPassword').value;
  if (newPassword.length < 10) return appMsg('A senha deve ter ao menos 10 caracteres.', true);
  if (newPassword !== confirmPassword) return appMsg('As senhas digitadas não são iguais.', true);

  try {
    await request(`/users/${id}/reset-password`, { method: 'PATCH', body: JSON.stringify({ newPassword }) });
    closeModal();
    appMsg('Senha redefinida com sucesso.');
    await loadUsers();
  } catch (e) { appMsg(e.message, true); }
}

async function handleCreateUser() {
  const body = {
    name: $('newUserName').value.trim(),
    password: $('newUserPassword').value,
    confirmPassword: $('newUserConfirmPassword').value,
    role: $('newUserRole').value,
  };
  if (!body.name || body.password.length < 10) {
    return appMsg('Preencha o nome e uma senha com ao menos 10 caracteres.', true);
  }
  if (body.password !== body.confirmPassword) {
    return appMsg('As senhas digitadas não são iguais.', true);
  }
  try {
    const created = await request('/auth/register', { method: 'POST', body: JSON.stringify(body) });
    $('newUserName').value = '';
    $('newUserPassword').value = '';
    $('newUserConfirmPassword').value = '';
    await loadUsers();
    openUsernameModal(created.username, created.active, false);
  } catch (e) { appMsg(e.message, true); }
}

async function handleChangeRole(id, newRole) {
  try {
    await request(`/users/${id}`, { method: 'PATCH', body: JSON.stringify({ role: newRole }) });
    appMsg('Perfil atualizado.');
  } catch (e) { appMsg(e.message, true); await loadUsers(); }
}

async function handleToggleActive(id, active) {
  try {
    await request(`/users/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) });
    appMsg(active ? 'Usuário aprovado.' : 'Usuário desativado.');
    await loadUsers();
  } catch (e) { appMsg(e.message, true); }
}

async function handleRejectUser(id, name) {
  if (!confirm(`Rejeitar o cadastro de "${name}"? A conta será excluída e não poderá mais ser aprovada — a pessoa precisará se cadastrar novamente, se quiser.`)) return;
  try {
    await request(`/users/${id}`, { method: 'DELETE' });
    appMsg('Cadastro rejeitado e removido.');
    await loadUsers();
  } catch (e) { appMsg(e.message, true); }
}

// =============================================================================
// Logs de atividade
// =============================================================================

const ACTION_LABELS = {
  LOGIN: 'Login', UPLOAD: 'Envio de arquivo', DOWNLOAD: 'Download de arquivo',
  DELETE: 'Exclusão de arquivo', RENAME_DOCUMENT: 'Renomeação de arquivo',
  CREATE_FOLDER: 'Criação de pasta', CREATE_SUBFOLDER: 'Criação de subpasta',
  DELETE_FOLDER: 'Remoção de pasta', UPDATE_FOLDER: 'Alteração de visibilidade',
  RENAME_FOLDER: 'Renomeação de pasta', DOWNLOAD_ZIP: 'Download de pasta (.zip)',
  CREATE_USER: 'Cadastro de usuário', UPDATE_USER: 'Atualização de usuário',
  APPROVE_USER: 'Aprovação de usuário', REJECT_USER: 'Rejeição de cadastro',
  PASSWORD_RESET_REQUEST: 'Solicitação de redefinição de senha', RESET_PASSWORD: 'Redefinição de senha',
  UPDATE_AVATAR: 'Atualização de foto de perfil',
};

// Monta uma descrição legível (o que exatamente foi feito, em qual
// pasta/arquivo/usuário) a partir dos metadados guardados no log — em vez de
// mostrar só um ID truncado, que não diz nada para quem não é técnico.
function describeLogEntry(l) {
  const m = l.metadata || {};
  switch (l.action) {
    case 'CREATE_FOLDER':
      return `"${m.name || ''}"`;
    case 'CREATE_SUBFOLDER':
      return m.parentName ? `"${m.name || ''}" dentro de "${m.parentName}"` : `"${m.name || ''}"`;
    case 'RENAME_FOLDER':
      return `"${m.rename?.from || ''}" → "${m.rename?.to || ''}"`;
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
      return `"${m.from || ''}" → "${m.to || ''}"`;
    case 'CREATE_USER':
      return `${m.username || ''}${m.role ? ` (${roleLabel(m.role)})` : ''}`;
    case 'UPDATE_USER':
    case 'APPROVE_USER': {
      const who = m.targetName || m.targetUsername || '';
      const parts = [];
      if (m.role) parts.push(`perfil → ${roleLabel(m.role)}`);
      if (m.active === true) parts.push('aprovado');
      if (m.active === false) parts.push('desativado');
      return `${who}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'REJECT_USER':
      return `${m.username || ''}`;
    case 'PASSWORD_RESET_REQUEST':
    case 'RESET_PASSWORD':
      return `${m.targetName || ''}${m.targetUsername ? ` (${m.targetUsername})` : ''}`;
    default:
      return m.name || '';
  }
}

let logFiltersInitialized = false;
let logSearchDebounceTimer = null;

function initLogFilters() {
  if (logFiltersInitialized) return;
  const select = $('logFilterAction');
  for (const [value, label] of Object.entries(ACTION_LABELS)) {
    select.insertAdjacentHTML('beforeend', `<option value="${value}">${label}</option>`);
  }
  logFiltersInitialized = true;
}

function currentLogFilterParams() {
  const params = new URLSearchParams();
  const action = $('logFilterAction').value;
  const from = $('logFilterFrom').value;
  const to = $('logFilterTo').value;
  const q = $('logFilterSearch').value.trim();
  if (action) params.set('action', action);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (q) params.set('q', q);
  return params;
}

// Evita disparar uma requisição a cada tecla digitada na busca.
function debouncedLoadAuditLogs() {
  clearTimeout(logSearchDebounceTimer);
  logSearchDebounceTimer = setTimeout(loadAuditLogs, 350);
}

function handleClearLogFilters() {
  $('logFilterAction').value = '';
  $('logFilterFrom').value = '';
  $('logFilterTo').value = '';
  $('logFilterSearch').value = '';
  loadAuditLogs();
}

async function loadAuditLogs() {
  initLogFilters();
  try {
    const params = currentLogFilterParams();
    params.set('take', '150');
    const logs = await request(`/audit-logs?${params.toString()}`);
    $('logsList').innerHTML = logs.length
      ? logs.map((l) => `
          <div class="list-item log-item">
            <span class="log-action">${ACTION_LABELS[l.action] || l.action}<small class="log-detail">${escapeHtml(describeLogEntry(l))}</small></span>
            <span class="log-actor">${l.user ? `${escapeHtml(l.user.username)} <small>(${escapeHtml(l.user.name)})</small>` : 'Sistema'}</span>
            <span class="log-date">${formatDate(l.createdAt)}</span>
          </div>`).join('')
      : '<p class="empty">Nenhum registro encontrado para esses filtros.</p>';
  } catch (e) { appMsg(e.message, true); }
}

async function handleExportLogs(format) {
  try {
    const params = currentLogFilterParams();
    params.set('format', format);
    const res = await fetch(`${api}/audit-logs/export?${params.toString()}`, { credentials: 'include' });
    if (!res.ok) {
      let msg = 'Não foi possível exportar os logs.';
      try { msg = (await res.json()).error || msg; } catch { /* corpo vazio */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : `logs.${format}`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) { appMsg(e.message, true); }
}

// =============================================================================
// Inicialização
// =============================================================================

(async function init() {
  try {
    currentUser = await request('/auth/me');
    await enterApp();
  } catch {
    await checkSetupStatus();
  }
})();
