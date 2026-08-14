const $ = id => document.getElementById(id);
let state;
let contentData = { user: [], server: [] };
let contentType = 'mod';
let libraryMode = 'user';
let catalogLoaded = false;
let toastTimer;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function showToast(message, tone = 'normal') {
  const toast = $('toast');
  toast.querySelector('p').textContent = message;
  toast.classList.toggle('error', tone === 'error');
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3800);
}

function showView(name) {
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  document.querySelectorAll('.nav-button').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  if (name === 'content') {
    refreshContent();
    if (!catalogLoaded) { catalogLoaded = true; runSearch(); }
  }
}

function formatGb(mb) {
  const value = mb / 1024;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} GB`;
}

function syncSettingsUi() {
  const settings = state.settings;
  $('installPath').textContent = settings.installationConfigured ? settings.instancePath : 'Not selected';
  $('ramSlider').max = settings.maxRamMb;
  $('ramSlider').value = settings.ramMb;
  $('ramOutput').textContent = formatGb(settings.ramMb);
  $('ramMax').textContent = formatGb(settings.maxRamMb);
  $('setupOverlay').classList.toggle('hidden', settings.installationConfigured);
}

function setAccount(account) {
  state.account = account;
  $('accountName').textContent = account ? account.name : 'Not signed in';
  $('accountHint').textContent = account ? 'Ready for BambiSMP' : 'Microsoft account required';
  $('loginButton').textContent = account ? 'Sign out' : 'Sign in with Microsoft';
  $('playButton').disabled = !account || !state.settings.installationConfigured;
  const avatar = $('accountAvatar');
  const container = avatar.parentElement;
  container.classList.remove('has-image');
  avatar.onload = () => container.classList.add('has-image');
  avatar.onerror = () => container.classList.remove('has-image');
  avatar.src = account?.avatarUrl || '../assets/alex-head.png';
}

window.bambi.onStatus(({ message, progress, tone }) => {
  $('statusText').textContent = message;
  if (progress !== null) $('progressBar').style.width = `${progress}%`;
  if (tone === 'error') showToast(message, 'error');
});

async function refreshServer() {
  $('serverState').textContent = 'Checking';
  $('serverStatusBadge').className = 'server-status-badge checking';
  try {
    const status = await window.bambi.getServerStatus();
    if (!status.online) throw new Error(status.error || 'Server is offline');
    $('onlineCount').textContent = status.playersOnline;
    $('maxCount').textContent = status.playersMax;
    $('serverMotd').textContent = status.motd || '✦ Cozy modded survival ✦';
    $('playerTooltip').textContent = status.sample?.length
      ? status.sample.join('\n')
      : status.playersOnline > 0 ? 'The server hides the player list.' : 'No players online';
    $('serverState').textContent = 'Online';
    $('serverStatusBadge').className = 'server-status-badge online';
    const icon = $('serverIcon');
    const wrapper = icon.parentElement;
    wrapper.classList.remove('has-image');
    if (status.favicon) {
      icon.onload = () => wrapper.classList.add('has-image');
      icon.src = status.favicon;
    }
  } catch (error) {
    $('onlineCount').textContent = '0';
    $('maxCount').textContent = '—';
    $('playerTooltip').textContent = 'Server is offline';
    $('serverMotd').textContent = 'The server did not answer the status check.';
    $('serverState').textContent = 'Offline';
    $('serverStatusBadge').className = 'server-status-badge offline';
  }
}

function contentLabel(type) {
  return type === 'mod' ? 'Client mod' : type === 'shader' ? 'Shader' : 'Resource pack';
}

function updateContentTypeUi() {
  document.querySelectorAll('[data-content-type]').forEach(button => button.classList.toggle('active', button.dataset.contentType === contentType));
  const hints = {
    mod: '.jar client mods · Minecraft 1.20.1 Forge',
    shader: '.zip shader packs · Oculus / Iris compatible',
    resourcepack: '.zip resource packs · Minecraft 1.20.1'
  };
  $('dropHint').textContent = hints[contentType];
  $('modrinthSearch').placeholder = `Search ${contentType === 'mod' ? 'client mods' : contentType === 'shader' ? 'shaders' : 'resource packs'} on Modrinth…`;
  renderLibrary();
}

function renderLibrary() {
  const source = libraryMode === 'user' ? contentData.user : contentData.server;
  const items = (libraryMode === 'server' ? source.filter(item => item.type === 'mod') : source.filter(item => item.type === contentType))
    .slice()
    .sort((left, right) => String(left.name || left.fileName).localeCompare(String(right.name || right.fileName), 'en', { sensitivity: 'base' }));
  $('libraryCount').textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
  $('libraryHelp').textContent = libraryMode === 'server'
    ? 'Required server mods. This list is view-only and updates from the live pack.'
    : 'Optional client content can be enabled or disabled.';
  const list = $('libraryList');
  if (!items.length) {
    list.innerHTML = `<div class="empty-state compact"><span>♡</span><strong>${libraryMode === 'server' ? 'Pack is not installed yet' : 'Nothing added yet'}</strong></div>`;
    return;
  }
  list.innerHTML = items.map(item => `
    <div class="library-item" data-item-id="${escapeHtml(item.id)}">
      <div class="library-item-icon">${item.iconUrl ? `<img src="${escapeHtml(item.iconUrl)}" alt="">` : contentType === 'mod' ? 'M' : contentType === 'shader' ? '✦' : '▧'}</div>
      <div class="library-item-copy"><strong title="${escapeHtml(item.fileName)}">${escapeHtml(item.name || item.fileName)}</strong><span>${escapeHtml(item.source || 'BambiSMP')}${item.versionNumber ? ` · ${escapeHtml(item.versionNumber)}` : ''}${item.conflict ? ' · file conflict' : ''}</span></div>
      <div class="library-actions">${libraryMode === 'server' ? '' : `<button class="toggle ${item.enabled ? 'on' : ''}" data-toggle="${escapeHtml(item.id)}" aria-label="Enable or disable"></button>${item.removable === false ? '' : `<button class="remove-button" data-remove="${escapeHtml(item.id)}" aria-label="Remove">×</button>`}`}</div>
    </div>`).join('');
  list.querySelectorAll('[data-toggle]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      contentData = await window.bambi.toggleContent(button.dataset.toggle, !button.classList.contains('on'));
      renderLibrary();
    } catch (error) { showToast(error.message, 'error'); }
  }));
  list.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      contentData = await window.bambi.removeContent(button.dataset.remove);
      renderLibrary();
      showToast('Content removed from your profile.');
    } catch (error) { showToast(error.message, 'error'); }
  }));
}

async function refreshContent() {
  try {
    contentData = await window.bambi.listContent();
    renderLibrary();
  } catch (error) { showToast(error.message, 'error'); }
}

function formatDownloads(value) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0);
}

async function runSearch() {
  const grid = $('catalogGrid');
  grid.classList.add('empty');
  grid.innerHTML = '<div class="empty-state"><span>୨ৎ</span><strong>Searching Modrinth…</strong></div>';
  $('searchButton').disabled = true;
  try {
    const response = await window.bambi.searchModrinth($('modrinthSearch').value.trim(), contentType, 0);
    $('searchSummary').textContent = `${response.total.toLocaleString()} compatible results`;
    grid.classList.toggle('empty', !response.results.length);
    if (!response.results.length) {
      grid.innerHTML = '<div class="empty-state"><span>♡</span><strong>No compatible results</strong><p>Try a different search phrase.</p></div>';
      return;
    }
    grid.innerHTML = response.results.map(item => `
      <article class="catalog-item">
        ${item.iconUrl ? `<img src="${escapeHtml(item.iconUrl)}" alt="">` : '<div class="catalog-icon">✦</div>'}
        <div><h4>${escapeHtml(item.title)}</h4><span class="author">by ${escapeHtml(item.author)}</span></div>
        <p>${escapeHtml(item.description)}</p>
        <footer><span>↓ ${formatDownloads(item.downloads)}</span><button class="install-button" data-install="${escapeHtml(item.id)}">Install</button></footer>
      </article>`).join('');
    grid.querySelectorAll('[data-install]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Installing…';
      try {
        contentData = await window.bambi.installModrinth(button.dataset.install, contentType);
        button.textContent = 'Installed ✓';
        renderLibrary();
        showToast('Installed with required dependencies ♡');
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Install';
        showToast(error.message, 'error');
      }
    }));
  } catch (error) {
    grid.innerHTML = `<div class="empty-state"><span>×</span><strong>Could not reach Modrinth</strong><p>${escapeHtml(error.message)}</p></div>`;
    showToast(error.message, 'error');
  } finally { $('searchButton').disabled = false; }
}

async function chooseInstallation() {
  const settings = await window.bambi.chooseInstallation();
  if (!settings) return;
  state.settings = settings;
  syncSettingsUi();
  setAccount(state.account);
  showToast('Installation folder saved. Welcome home ♡');
}

document.querySelectorAll('.nav-button').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelectorAll('[data-view-link]').forEach(button => button.addEventListener('click', () => showView(button.dataset.viewLink)));
$('minimize').addEventListener('click', () => window.bambiWindow.minimize());
$('maximize').addEventListener('click', async () => { const maximized = await window.bambiWindow.maximize(); $('maximize').textContent = maximized ? '❐' : '□'; });
$('close').addEventListener('click', () => window.bambiWindow.close());
$('setupChoose').addEventListener('click', chooseInstallation);
$('changeInstallation').addEventListener('click', chooseInstallation);
$('openFolder').addEventListener('click', () => window.bambi.openFolder());
$('openMapBrowser').addEventListener('click', () => window.bambi.openMap());
$('mapFallbackButton').addEventListener('click', () => window.bambi.openMap());
$('ramSlider').addEventListener('input', event => { $('ramOutput').textContent = formatGb(Number(event.target.value)); });
$('saveSettings').addEventListener('click', async () => {
  try {
    state.settings = await window.bambi.saveSettings({ ramMb: Number($('ramSlider').value) });
    syncSettingsUi();
    showToast('Settings saved ♡');
  } catch (error) { showToast(error.message, 'error'); }
});
$('loginButton').addEventListener('click', async () => {
  $('loginButton').disabled = true;
  try {
    if (state.account) { await window.bambi.logout(); setAccount(null); }
    else setAccount(await window.bambi.login());
  } catch (error) { showToast(error.message || 'Sign-in could not be completed.', 'error'); }
  finally { $('loginButton').disabled = false; }
});
$('playButton').addEventListener('click', async () => {
  $('playButton').disabled = true;
  try {
    const result = await window.bambi.play();
    if (!result.ok) showToast(result.error || 'Launch failed.', 'error');
  } catch (error) { showToast(error.message || 'Launch failed.', 'error'); }
  finally { $('playButton').disabled = !state.account || !state.settings.installationConfigured; }
});
document.querySelectorAll('[data-content-type]').forEach(button => button.addEventListener('click', () => {
  contentType = button.dataset.contentType;
  updateContentTypeUi();
  runSearch();
}));
document.querySelectorAll('[data-library]').forEach(button => button.addEventListener('click', () => {
  libraryMode = button.dataset.library;
  document.querySelectorAll('[data-library]').forEach(item => item.classList.toggle('active', item.dataset.library === libraryMode));
  renderLibrary();
}));
$('searchButton').addEventListener('click', runSearch);
$('modrinthSearch').addEventListener('keydown', event => { if (event.key === 'Enter') runSearch(); });
$('addFromPc').addEventListener('click', async () => {
  try { contentData = await window.bambi.pickContent(contentType); renderLibrary(); }
  catch (error) { showToast(error.message, 'error'); }
});
const dropZone = $('dropZone');
['dragenter', 'dragover'].forEach(name => dropZone.addEventListener(name, event => { event.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(name => dropZone.addEventListener(name, event => { event.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', async event => {
  try {
    contentData = await window.bambi.addDroppedFiles(event.dataTransfer.files, contentType);
    renderLibrary();
    showToast('Dropped content added ♡');
  } catch (error) { showToast(error.message, 'error'); }
});

async function boot() {
  state = await window.bambi.getState();
  $('versionText').textContent = `v${state.version}`;
  syncSettingsUi();
  setAccount(state.account);
  updateContentTypeUi();
  await Promise.allSettled([refreshServer(), refreshContent()]);
  setInterval(refreshServer, 30000);
}

boot().catch(error => showToast(error.message || 'Launcher could not start.', 'error'));
