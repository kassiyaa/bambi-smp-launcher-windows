const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const os = require('os');
const net = require('net');
const dns = require('dns').promises;
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const extract = require('extract-zip');
const yauzl = require('yauzl');
const { Auth } = require('msmc');
const defaults = require('../config/defaults.json');
const optionalContent = require('../config/optional-content.json');
const bundledServerContent = require('../config/server-content.json');
const OPTIONAL_CONTENT_ICONS = {
  'chat_heads-0.15.5-forge-1.20.jar': 'chat-heads.png',
  'chatanimation-forge-1.3.0+mc1.20.1.jar': 'chat-animation.webp',
  'embeddium-0.3.31+mc1.20.1.jar': 'embeddium.webp',
  'jei-1.20.1-forge-15.20.0.112.jar': 'jei.webp',
  'notenoughanimations-forge-1.11.1-mc1.20.1.jar': 'not-enough-animations.webp',
  'obscure_tooltips-forge-1.20.1-3.10.0.jar': 'obscure-tooltips.webp',
  'oculus-mc1.20.1-1.8.0.jar': 'oculus.webp',
  'simplefullbright-forge-1.20.1-1.0.2.jar': 'simple-fullbright.webp',
  'skinlayers3d-forge-1.11.2-mc1.20.1.jar': '3d-skin-layers.webp',
  'sodiumdynamiclights-forge-1.0.10-1.20.1.jar': 'sodium-dynamic-lights.webp',
  'sodiumoptionsapi-forge-1.0.10-1.20.1.jar': 'sodium-options-api.webp',
  'swinginglanterns-1.20.1-1.5.0.1.jar': 'swinging-lanterns.webp',
  'xaerominimap-forge-1.20.1-26.4.2.jar': 'xaeros-minimap.webp',
  'xaeroworldmap-forge-1.20.1-1.44.2.jar': 'xaeros-world-map.webp',
  'yet_another_config_lib_v3-3.6.6+1.20.1-forge.jar': 'yacl.webp'
};

const MANAGED_DIRECTORIES = ['mods', 'config', 'defaultconfigs', 'datapacks', 'resourcepacks', 'shaderpacks', 'kubejs', 'scripts'];
const CONTENT_TYPES = {
  mod: { directory: 'mods', extensions: ['.jar'] },
  resourcepack: { directory: 'resourcepacks', extensions: ['.zip'] },
  shader: { directory: 'shaderpacks', extensions: ['.zip'] }
};
const PERSONAL_PATHS = [
  'config/xaero',
  'config/jei',
  'config/bambi-homes.json',
  'config/resourceful-config-web.json'
];
const OPTIONAL_CONTENT_PATHS = new Set(optionalContent.map(item => item.path.toLowerCase()));
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

let mainWindow;
let currentAccount = null;
let activeXboxSession = null;
let minecraftProcess = null;
const jarMetadataCache = new Map();

const userData = () => app.getPath('userData');
const settingsFile = () => path.join(userData(), 'settings.json');
const authFile = () => path.join(userData(), 'auth.bin');
const legacyInstancePath = () => path.join(userData(), 'game');
const legacyResourcePath = () => {
  const official = path.join(process.env.APPDATA || userData(), '.minecraft');
  return fs.existsSync(path.join(official, 'versions', defaults.minecraftVersion)) ? official : path.join(userData(), 'resources');
};
const logFile = () => path.join(userData(), 'logs', 'launcher.log');
const contentRegistryFile = () => path.join(userData(), 'user-content.json');
const contentStoreRoot = () => path.join(userData(), 'user-content');
const uninstallPathFile = () => path.join(userData(), 'uninstall-path.txt');
const uninstallOwnerFile = () => path.join(userData(), 'uninstall-owner.txt');
const instanceOwnerFile = instancePath => path.join(instancePath, '.bambismp-launcher-owner');
const launcherUserAgent = () => `BambiSMPLauncher/${app.getVersion()}`;

async function recordUninstallPath(instancePath) {
  if (!instancePath) return;
  const resolvedPath = path.resolve(instancePath);
  await fsp.mkdir(userData(), { recursive: true });
  await fsp.mkdir(resolvedPath, { recursive: true });

  let ownerToken = '';
  try { ownerToken = (await fsp.readFile(uninstallOwnerFile(), 'utf8')).trim(); } catch { /* First run. */ }
  if (!/^[0-9a-f-]{36}$/i.test(ownerToken)) ownerToken = crypto.randomUUID();

  await fsp.writeFile(uninstallPathFile(), resolvedPath, 'utf8');
  await fsp.writeFile(uninstallOwnerFile(), ownerToken, 'utf8');
  await fsp.writeFile(instanceOwnerFile(resolvedPath), ownerToken, 'utf8');
}

function hardwareRamLimitMb() {
  return Math.max(defaults.minimumRamMb, Math.floor((os.totalmem() / 1024 / 1024) / 512) * 512);
}

function defaultRamMb() {
  return Math.max(defaults.minimumRamMb, Math.floor((os.totalmem() / 1024 / 1024 * 0.75) / 512) * 512);
}

function sendStatus(message, progress = null, tone = 'normal') {
  mainWindow?.webContents.send('launcher:status', { message, progress, tone });
}

async function writeLog(message, error) {
  try {
    const suffix = error ? `\n${error.stack || error.message || String(error)}` : '';
    await fsp.mkdir(path.dirname(logFile()), { recursive: true });
    await fsp.appendFile(logFile(), `[${new Date().toISOString()}] ${message}${suffix}\n`, 'utf8');
  } catch { /* Logging must never stop the launcher. */ }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function megabytes(bytes) { return (Math.max(0, Number(bytes) || 0) / 1024 / 1024).toFixed(1); }

function mimeFromPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'image/png';
}

function readZipEntry(file, wantedEntry) {
  const wanted = String(wantedEntry || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  if (!wanted) return Promise.resolve(null);
  return new Promise(resolve => {
    yauzl.open(file, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) return resolve(null);
      const finish = value => {
        zip.close();
        resolve(value);
      };
      zip.readEntry();
      zip.on('entry', entry => {
        const entryName = entry.fileName.replace(/\\/g, '/').toLowerCase();
        if (entryName !== wanted) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return finish(null);
          const chunks = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => finish(Buffer.concat(chunks)));
          stream.on('error', () => finish(null));
        });
      });
      zip.on('end', () => finish(null));
      zip.on('error', () => finish(null));
    });
  });
}

async function readJarMetadata(file) {
  try {
    const stat = await fsp.stat(file);
    const cacheKey = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (jarMetadataCache.has(cacheKey)) return jarMetadataCache.get(cacheKey);
    const metadata = { name: null, iconUrl: null };
    const modsToml = await readZipEntry(file, 'META-INF/mods.toml');
    if (modsToml) {
      const toml = modsToml.toString('utf8');
      const nameMatch = toml.match(/^\s*displayName\s*=\s*"([^"]+)"/m);
      const logoMatch = toml.match(/^\s*logoFile\s*=\s*"([^"]+)"/m);
      if (nameMatch?.[1]) metadata.name = nameMatch[1].trim();
      if (logoMatch?.[1]) {
        const logoFile = logoMatch[1].trim().replace(/\\/g, '/').replace(/^\/+/, '');
        if (!logoFile.includes('..')) {
          const icon = await readZipEntry(file, logoFile);
          if (icon && icon.length <= 512 * 1024) metadata.iconUrl = `data:${mimeFromPath(logoFile)};base64,${icon.toString('base64')}`;
        }
      }
    }
    jarMetadataCache.clear();
    jarMetadataCache.set(cacheKey, metadata);
    return metadata;
  } catch {
    return { name: null, iconUrl: null };
  }
}

async function createServerContentItem(root, relative) {
  const fileName = path.posix.basename(relative);
  const localFile = path.join(root, ...relative.split('/'));
  const metadata = await readJarMetadata(localFile);
  return {
    id: `server:mod:${fileName}`,
    type: 'mod',
    fileName,
    name: metadata.name || fileName.replace(/\.jar$/i, ''),
    source: 'BambiSMP Required',
    locked: true,
    enabled: true,
    iconUrl: metadata.iconUrl
  };
}

async function retryOperation(label, operation, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(attempt); }
    catch (error) {
      lastError = error;
      await writeLog(`${label} failed (attempt ${attempt}/${attempts}).`, error);
      if (attempt === attempts) break;
      sendStatus(`${label} had a temporary error. Retrying ${attempt + 1}/${attempts}…`);
      await delay(Math.min(8000, 1000 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

async function isReadableZip(file) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 22) return false;
    const header = Buffer.alloc(4);
    await handle.read(header, 0, 4, 0);
    if (header[0] !== 0x50 || header[1] !== 0x4b) return false;
    const tailSize = Math.min(stat.size, 65557);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, stat.size - tailSize);
    return tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0;
  } catch { return false; }
  finally { await handle?.close().catch(() => {}); }
}

async function fetchWithRetry(url, options = {}, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (!RETRYABLE_HTTP_STATUS.has(response.status) || attempt === attempts) return response;
      await response.body?.cancel().catch(() => {});
      lastError = new Error(`Temporary download error (${response.status}).`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }
    await delay(Math.min(8000, 650 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 350));
  }
  throw lastError;
}

async function getSettings() {
  const saved = await readJson(settingsFile(), {});
  const legacyExists = fs.existsSync(legacyInstancePath());
  const dynamicMax = hardwareRamLimitMb();
  const selectedInstance = saved.instancePath || legacyInstancePath();
  const settings = {
    ramMb: Math.min(dynamicMax, Number.isFinite(Number(saved.ramMb)) ? Number(saved.ramMb) : defaultRamMb()),
    maxRamMb: dynamicMax,
    instancePath: selectedInstance,
    resourcePath: saved.resourcePath || (saved.instancePath ? path.join(selectedInstance, '.minecraft') : legacyResourcePath()),
    installationConfigured: Boolean(saved.instancePath) || legacyExists,
    manifestUrl: defaults.manifestUrl,
    mapUrl: defaults.mapUrl,
    serverAddress: defaults.serverAddress
  };
  if (settings.installationConfigured) await recordUninstallPath(settings.instancePath);
  return settings;
}

async function saveSettings(next) {
  const safe = await getSettings();
  if (Number.isFinite(Number(next.ramMb))) {
    safe.ramMb = Math.min(safe.maxRamMb, Math.max(defaults.minimumRamMb, Number(next.ramMb)));
  }
  if (typeof next.instancePath === 'string' && next.instancePath.trim()) {
    safe.instancePath = path.resolve(next.instancePath.trim());
    safe.resourcePath = path.join(safe.instancePath, '.minecraft');
    safe.installationConfigured = true;
  }
  await fsp.mkdir(userData(), { recursive: true });
  await fsp.writeFile(settingsFile(), JSON.stringify({
    ramMb: safe.ramMb,
    instancePath: safe.instancePath,
    resourcePath: safe.resourcePath
  }, null, 2), 'utf8');
  await recordUninstallPath(safe.instancePath);
  return safe;
}

async function chooseInstallationDirectory() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose where BambiSMP should be installed',
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const picked = path.resolve(result.filePaths[0]);
  const target = path.basename(picked).toLowerCase() === 'bambismp' ? picked : path.join(picked, 'BambiSMP');
  await fsp.mkdir(target, { recursive: true });
  return saveSettings({ instancePath: target });
}

function encodeVarInt(value) {
  const bytes = [];
  let current = value >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current) byte |= 0x80;
    bytes.push(byte);
  } while (current);
  return Buffer.from(bytes);
}

function decodeVarInt(buffer, offset = 0) {
  let value = 0;
  let position = 0;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor++];
    value |= (byte & 0x7f) << position;
    if ((byte & 0x80) === 0) return { value, size: cursor - offset };
    position += 7;
    if (position >= 35) throw new Error('Invalid Minecraft VarInt.');
  }
  return null;
}

function encodeMinecraftString(value) {
  const body = Buffer.from(String(value), 'utf8');
  return Buffer.concat([encodeVarInt(body.length), body]);
}

function flattenMotd(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const own = typeof value.text === 'string' ? value.text : '';
  const extra = Array.isArray(value.extra) ? value.extra.map(flattenMotd).join('') : '';
  return `${own}${extra}`;
}

async function resolveMinecraftEndpoint(address) {
  const parsed = parseServerAddress(address);
  if (!parsed) throw new Error('Invalid server address.');
  if (parsed.port) return { host: parsed.ip, port: parsed.port, handshakeHost: parsed.ip };
  try {
    const records = await dns.resolveSrv(`_minecraft._tcp.${parsed.ip}`);
    const record = records.sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
    if (record) return { host: record.name, port: record.port, handshakeHost: parsed.ip };
  } catch { /* The standard port is valid when no SRV record exists. */ }
  return { host: parsed.ip, port: 25565, handshakeHost: parsed.ip };
}

async function fetchServerStatus() {
  const address = defaults.serverAddress;
  const endpoint = await resolveMinecraftEndpoint(address);
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    let received = Buffer.alloc(0);
    const fail = error => { socket.destroy(); reject(error); };
    socket.setTimeout(5000, () => fail(new Error('Server status timed out.')));
    socket.once('error', fail);
    socket.once('connect', () => {
      const handshakeBody = Buffer.concat([
        encodeVarInt(0), encodeVarInt(763), encodeMinecraftString(endpoint.handshakeHost),
        Buffer.from([(endpoint.port >> 8) & 0xff, endpoint.port & 0xff]), encodeVarInt(1)
      ]);
      socket.write(Buffer.concat([encodeVarInt(handshakeBody.length), handshakeBody, Buffer.from([1, 0])]));
    });
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      try {
        const packetLength = decodeVarInt(received, 0);
        if (!packetLength || received.length < packetLength.size + packetLength.value) return;
        let cursor = packetLength.size;
        const packetId = decodeVarInt(received, cursor);
        if (!packetId || packetId.value !== 0) throw new Error('Unexpected Minecraft status packet.');
        cursor += packetId.size;
        const jsonLength = decodeVarInt(received, cursor);
        if (!jsonLength) return;
        cursor += jsonLength.size;
        const payload = JSON.parse(received.subarray(cursor, cursor + jsonLength.value).toString('utf8'));
        socket.end();
        resolve({
          online: true,
          address,
          latency: Date.now() - startedAt,
          playersOnline: Number(payload.players?.online || 0),
          playersMax: Number(payload.players?.max || 0),
          sample: (payload.players?.sample || []).map(player => player.name).slice(0, 8),
          motd: flattenMotd(payload.description).replace(/§./g, '').trim(),
          favicon: typeof payload.favicon === 'string' ? payload.favicon : null,
          version: payload.version?.name || 'Minecraft 1.20.1'
        });
      } catch (error) { fail(error); }
    });
  }).catch(error => ({ online: false, address, error: error.message, playersOnline: 0, playersMax: 0 }));
}

async function loadContentRegistry() {
  const registry = await readJson(contentRegistryFile(), { schemaVersion: 1, items: [], deployed: [] });
  if (!Array.isArray(registry.items)) registry.items = [];
  if (!Array.isArray(registry.deployed)) registry.deployed = [];
  for (const definition of optionalContent) {
    const fileName = path.basename(definition.path);
    let item = registry.items.find(entry => entry.builtInOptional && entry.fileName.toLowerCase() === fileName.toLowerCase());
    if (!item) {
      item = {
        id: `optional:${definition.sha256.slice(0, 16)}`,
        type: 'mod', fileName, name: definition.name, source: 'BambiSMP Optional',
        enabled: true, builtInOptional: true, removable: false, updatePolicy: 'never',
        pinnedUrl: definition.url, pinnedSha256: definition.sha256, pinnedSize: definition.size
      };
      registry.items.push(item);
    }
    Object.assign(item, {
      name: definition.name,
      source: 'BambiSMP Optional',
      iconUrl: `../assets/mod-icons/${OPTIONAL_CONTENT_ICONS[fileName.toLowerCase()]}`,
      builtInOptional: true,
      removable: false,
      updatePolicy: 'never',
      pinnedUrl: definition.url,
      pinnedSha256: definition.sha256,
      pinnedSize: definition.size
    });
  }
  return registry;
}

async function saveContentRegistry(registry) {
  await fsp.mkdir(path.dirname(contentRegistryFile()), { recursive: true });
  const temporary = `${contentRegistryFile()}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(registry, null, 2), 'utf8');
  await fsp.rename(temporary, contentRegistryFile());
}

async function hashFile(file, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    fs.createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

function contentStorePath(item) {
  return path.join(contentStoreRoot(), item.type, path.basename(item.fileName));
}

function contentTargetPath(root, item) {
  return path.join(root, CONTENT_TYPES[item.type].directory, path.basename(item.fileName));
}

async function removeDeployedContent(root, registry) {
  for (const deployed of registry.deployed) {
    if (!CONTENT_TYPES[deployed.type]) continue;
    const target = contentTargetPath(root, deployed);
    const source = contentStorePath(deployed);
    if (!fs.existsSync(target) || !fs.existsSync(source)) continue;
    const [targetHash, sourceHash] = await Promise.all([hashFile(target, 'sha256'), hashFile(source, 'sha256')]).catch(() => []);
    if (targetHash && targetHash === sourceHash) await fsp.rm(target, { force: true });
  }
  registry.deployed = [];
}

async function updateResourcePackOptions(root, registry) {
  const optionsFile = path.join(root, 'options.txt');
  const all = registry.items.filter(item => item.type === 'resourcepack').map(item => `file/${item.fileName}`);
  const enabled = registry.items.filter(item => item.type === 'resourcepack' && item.enabled).map(item => `file/${item.fileName}`);
  let lines = fs.existsSync(optionsFile) ? (await fsp.readFile(optionsFile, 'utf8')).split(/\r?\n/) : [];
  const index = lines.findIndex(line => line.startsWith('resourcePacks:'));
  let selected = [];
  if (index >= 0) {
    try { selected = JSON.parse(lines[index].slice('resourcePacks:'.length)); } catch { selected = []; }
  }
  selected = selected.filter(name => !all.includes(name));
  for (const name of enabled) if (!selected.includes(name)) selected.push(name);
  const next = `resourcePacks:${JSON.stringify(selected)}`;
  if (index >= 0) lines[index] = next; else lines.push(next);
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(optionsFile, lines.filter(Boolean).join(os.EOL) + os.EOL, 'utf8');
}

async function updateShaderOptions(root, registry) {
  const optionsFile = path.join(root, 'optionsshaders.txt');
  const active = registry.items.find(item => item.type === 'shader' && item.enabled);
  let lines = fs.existsSync(optionsFile) ? (await fsp.readFile(optionsFile, 'utf8')).split(/\r?\n/) : [];
  const index = lines.findIndex(line => line.startsWith('shaderPack='));
  const next = `shaderPack=${active ? active.fileName : 'OFF'}`;
  if (index >= 0) lines[index] = next; else lines.push(next);
  await fsp.writeFile(optionsFile, lines.filter(Boolean).join(os.EOL) + os.EOL, 'utf8');
}

async function applyUserContent(root) {
  const registry = await loadContentRegistry();
  await removeDeployedContent(root, registry);
  for (const item of registry.items.filter(entry => entry.builtInOptional && !entry.enabled)) {
    const target = contentTargetPath(root, item);
    if (fs.existsSync(target) && (await sha256(target)).toLowerCase() === item.pinnedSha256.toLowerCase()) await fsp.rm(target, { force: true });
  }
  for (const item of registry.items.filter(item => item.enabled)) {
    if (!CONTENT_TYPES[item.type]) continue;
    const source = contentStorePath(item);
    const target = contentTargetPath(root, item);
    if (!fs.existsSync(source)) continue;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      if (item.builtInOptional && (await sha256(target)).toLowerCase() === (await sha256(source)).toLowerCase()) {
        item.conflict = false;
        registry.deployed.push({ type: item.type, fileName: item.fileName });
        continue;
      }
      item.conflict = true;
      continue;
    }
    item.conflict = false;
    await fsp.copyFile(source, target);
    registry.deployed.push({ type: item.type, fileName: item.fileName });
  }
  await updateResourcePackOptions(root, registry);
  await updateShaderOptions(root, registry);
  await saveContentRegistry(registry);
  return registry;
}

async function listContent() {
  const settings = await getSettings();
  const registry = await loadContentRegistry();
  const userNames = new Set(registry.items.map(item => `${item.type}:${item.fileName.toLowerCase()}`));
  const server = [];
  const addServerPath = async relative => {
    if (!relative || !relative.toLowerCase().startsWith('mods/') || !relative.toLowerCase().endsWith('.jar')) return;
    if (OPTIONAL_CONTENT_PATHS.has(relative.toLowerCase())) return;
    if (server.some(item => item.fileName.toLowerCase() === path.posix.basename(relative).toLowerCase())) return;
    server.push(await createServerContentItem(settings.instancePath, relative));
  };
  try {
    const manifest = await fetchManifest(settings.manifestUrl);
    if (manifest.schemaVersion === 2) {
      for (const file of manifest.files) {
        const relative = normalizePackPath(file.path);
        await addServerPath(relative);
      }
    }
  } catch (error) {
    await writeLog('The live Server Content list could not be loaded; using bundled or installed files.', error);
  }
  if (!server.length) {
    for (const item of bundledServerContent) await addServerPath(normalizePackPath(item.path));
  }
  if (!server.length) {
    const directory = path.join(settings.instancePath, CONTENT_TYPES.mod.directory);
    const files = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of files) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.jar') continue;
      if (userNames.has(`mod:${entry.name.toLowerCase()}`) || OPTIONAL_CONTENT_PATHS.has(`mods/${entry.name.toLowerCase()}`)) continue;
      await addServerPath(`mods/${entry.name}`);
    }
  }
  try { await saveContentRegistry(registry); }
  catch (error) { await writeLog('The content registry could not be saved while listing content.', error); }
  server.sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }));
  return { user: registry.items, server };
}

async function registerLocalContent(files, type) {
  const config = CONTENT_TYPES[type];
  if (!config) throw new Error('Unsupported content type.');
  const settings = await getSettings();
  if (!settings.installationConfigured) throw new Error('Choose an installation folder first.');
  const registry = await loadContentRegistry();
  for (const sourceFile of files) {
    const fileName = path.basename(sourceFile);
    const extension = path.extname(fileName).toLowerCase();
    if (!config.extensions.includes(extension)) throw new Error(`${fileName} is not valid ${type} content.`);
    if (!fs.existsSync(sourceFile)) throw new Error(`${fileName} could not be found.`);
    if (registry.items.some(item => item.type === type && item.fileName.toLowerCase() === fileName.toLowerCase())) continue;
    const serverTarget = path.join(settings.instancePath, config.directory, fileName);
    if (fs.existsSync(serverTarget)) throw new Error(`${fileName} is already managed by the BambiSMP pack.`);
    const item = { id: crypto.randomUUID(), type, fileName, name: fileName.replace(/\.(jar|zip)$/i, ''), source: 'Local file', enabled: true, addedAt: new Date().toISOString() };
    await fsp.mkdir(path.dirname(contentStorePath(item)), { recursive: true });
    await fsp.copyFile(sourceFile, contentStorePath(item));
    registry.items.push(item);
  }
  await saveContentRegistry(registry);
  await applyUserContent(settings.instancePath);
  return listContent();
}

async function pickLocalContent(type) {
  const config = CONTENT_TYPES[type];
  if (!config) throw new Error('Unsupported content type.');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `Add ${type === 'mod' ? 'client mod' : type}`,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: type === 'mod' ? 'Minecraft mods' : 'Minecraft packs', extensions: config.extensions.map(ext => ext.slice(1)) }]
  });
  if (result.canceled) return listContent();
  return registerLocalContent(result.filePaths, type);
}

async function toggleContent(id, enabled) {
  const settings = await getSettings();
  const registry = await loadContentRegistry();
  const item = registry.items.find(entry => entry.id === id);
  if (!item) throw new Error('Content item could not be found.');
  if (item.type === 'shader' && enabled) {
    for (const other of registry.items) if (other.type === 'shader') other.enabled = false;
  }
  item.enabled = Boolean(enabled);
  await saveContentRegistry(registry);
  await applyUserContent(settings.instancePath);
  return listContent();
}

async function removeContent(id) {
  const settings = await getSettings();
  const registry = await loadContentRegistry();
  const index = registry.items.findIndex(entry => entry.id === id);
  if (index < 0) throw new Error('Content item could not be found.');
  if (registry.items[index].builtInOptional || registry.items[index].removable === false) throw new Error('Default optional content can be disabled, but not removed.');
  const [item] = registry.items.splice(index, 1);
  await removeDeployedContent(settings.instancePath, registry);
  await fsp.rm(contentStorePath(item), { force: true });
  await saveContentRegistry(registry);
  await applyUserContent(settings.instancePath);
  return listContent();
}

async function modrinthJson(route) {
  const response = await fetch(`https://api.modrinth.com/v2${route}`, { headers: { 'User-Agent': `${launcherUserAgent()} (https://bambismp.site)` } });
  if (!response.ok) throw new Error(`Modrinth request failed (${response.status}).`);
  return response.json();
}

async function searchModrinth(query, type = 'mod', offset = 0) {
  if (!CONTENT_TYPES[type]) throw new Error('Unsupported content type.');
  const facets = [[`project_type:${type}`], [`versions:${defaults.minecraftVersion}`]];
  if (type === 'mod') facets.push(['categories:forge'], ['client_side:required', 'client_side:optional'], ['server_side:unsupported']);
  const params = new URLSearchParams({ query: String(query || ''), facets: JSON.stringify(facets), limit: '24', offset: String(Math.max(0, Number(offset) || 0)), index: 'relevance' });
  const result = await modrinthJson(`/search?${params}`);
  return {
    total: result.total_hits,
    results: result.hits.map(hit => ({ id: hit.project_id, slug: hit.slug, type: hit.project_type, title: hit.title, description: hit.description, author: hit.author, downloads: hit.downloads, iconUrl: hit.icon_url, clientSide: hit.client_side }))
  };
}

async function downloadFile(url, destination) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || (parsed.hostname !== 'modrinth.com' && !parsed.hostname.endsWith('.modrinth.com'))) throw new Error('Unexpected Modrinth download host.');
  const response = await fetch(url, { headers: { 'User-Agent': launcherUserAgent() } });
  if (!response.ok || !response.body) throw new Error(`Content download failed (${response.status}).`);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
}

async function installModrinthVersion(projectId, type, registry, seen, forcedVersionId) {
  if (seen.has(projectId)) return;
  seen.add(projectId);
  const project = await modrinthJson(`/project/${encodeURIComponent(projectId)}`);
  let version;
  if (forcedVersionId) {
    version = await modrinthJson(`/version/${encodeURIComponent(forcedVersionId)}`);
  } else {
    const params = new URLSearchParams({ game_versions: JSON.stringify([defaults.minecraftVersion]), include_changelog: 'false' });
    if (type === 'mod') params.set('loaders', JSON.stringify(['forge']));
    if (type === 'shader') params.set('loaders', JSON.stringify(['iris']));
    const versions = await modrinthJson(`/project/${encodeURIComponent(projectId)}/version?${params}`);
    version = versions.find(entry => entry.version_type === 'release') || versions[0];
  }
  if (!version) throw new Error(`${project.title} has no compatible ${defaults.minecraftVersion} version.`);
  for (const dependency of version.dependencies || []) {
    if (dependency.dependency_type === 'required' && dependency.project_id) {
      await installModrinthVersion(dependency.project_id, 'mod', registry, seen, dependency.version_id || undefined);
    }
  }
  const file = version.files.find(entry => entry.primary) || version.files[0];
  if (!file) throw new Error(`${project.title} has no downloadable file.`);
  const fileName = path.basename(file.filename);
  const existing = registry.items.find(item => item.projectId === projectId);
  const item = existing || { id: crypto.randomUUID(), addedAt: new Date().toISOString(), enabled: true };
  if (existing && existing.fileName !== fileName) await fsp.rm(contentStorePath(existing), { force: true });
  Object.assign(item, { type, fileName, name: project.title, author: project.team || '', source: 'Modrinth', projectId, versionId: version.id, versionNumber: version.version_number, iconUrl: project.icon_url || null, enabled: existing ? existing.enabled : true });
  const destination = contentStorePath(item);
  await downloadFile(file.url, destination);
  const algorithm = file.hashes?.sha512 ? 'sha512' : 'sha1';
  const expected = file.hashes?.[algorithm];
  if (expected && (await hashFile(destination, algorithm)).toLowerCase() !== expected.toLowerCase()) {
    await fsp.rm(destination, { force: true });
    throw new Error(`${project.title} failed file verification.`);
  }
  if (!existing) registry.items.push(item);
}

async function installModrinthProject(projectId, type) {
  const settings = await getSettings();
  if (!settings.installationConfigured) throw new Error('Choose an installation folder first.');
  const registry = await loadContentRegistry();
  await installModrinthVersion(String(projectId), type, registry, new Set());
  await saveContentRegistry(registry);
  await applyUserContent(settings.instancePath);
  return listContent();
}

async function storeRefreshToken(token) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable.');
  await fsp.mkdir(userData(), { recursive: true });
  await fsp.writeFile(authFile(), safeStorage.encryptString(token));
}

async function restoreSession() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    const refreshToken = safeStorage.decryptString(await fsp.readFile(authFile()));
    const manager = new Auth('select_account');
    activeXboxSession = await manager.refresh(refreshToken);
    const minecraft = await activeXboxSession.getMinecraft();
    currentAccount = { name: minecraft.profile.name, id: minecraft.profile.id, accessToken: minecraft.mcToken };
  } catch (error) {
    currentAccount = null;
    activeXboxSession = null;
    if (error.code !== 'ENOENT') await writeLog('Saved Microsoft session could not be restored.', error);
  }
}

function validateManifest(manifest) {
  if (!manifest || ![1, 2].includes(manifest.schemaVersion)) throw new Error('Unsupported launcher manifest version.');
  if (!String(manifest.packVersion || '').trim()) throw new Error('The modpack version is missing from the manifest.');
  if (manifest.schemaVersion === 1) {
    if (!/^https:\/\//i.test(String(manifest.instanceZipUrl || ''))) throw new Error('The modpack download URL is invalid.');
    if (!/^[a-f0-9]{64}$/i.test(String(manifest.instanceZipSha256 || ''))) throw new Error('The modpack SHA-256 value is invalid.');
  } else {
    if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('The file-based modpack manifest is empty.');
    const seen = new Set();
    for (const file of manifest.files) {
      const relative = normalizePackPath(file.path);
      if (!relative || seen.has(relative.toLowerCase())) throw new Error('The modpack contains an invalid or duplicate file path.');
      seen.add(relative.toLowerCase());
      if (!/^https:\/\//i.test(String(file.url || ''))) throw new Error(`The download URL for ${relative} is invalid.`);
      if (!/^[a-f0-9]{64}$/i.test(String(file.sha256 || ''))) throw new Error(`The SHA-256 for ${relative} is invalid.`);
      if (!Number.isSafeInteger(Number(file.size)) || Number(file.size) < 0) throw new Error(`The size for ${relative} is invalid.`);
    }
    if (manifest.removedPaths !== undefined && !Array.isArray(manifest.removedPaths)) throw new Error('The removed-path list is invalid.');
    for (const removed of manifest.removedPaths || []) if (!normalizePackPath(removed)) throw new Error('The removed-path list contains an unsafe path.');
  }
  return manifest;
}

function normalizePackPath(value) {
  const relative = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relative || relative.includes('\0') || relative.split('/').some(part => !part || part === '.' || part === '..')) return null;
  if (!MANAGED_DIRECTORIES.includes(relative.split('/')[0])) return null;
  return relative;
}

async function fetchManifest(url) {
  const response = await fetchWithRetry(url, {
    cache: 'no-store',
    headers: { 'User-Agent': launcherUserAgent(), Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Could not fetch update information (${response.status}).`);
  return validateManifest(await response.json());
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', data => hash.update(data))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function downloadModpack(manifest, destination) {
  const response = await fetch(manifest.instanceZipUrl, {
    headers: { 'User-Agent': launcherUserAgent(), Accept: 'application/zip' }
  });
  if (!response.ok || !response.body) throw new Error(`Could not download the modpack (${response.status}).`);

  const total = Number(response.headers.get('content-length') || 0);
  let received = 0;
  let lastPercent = -1;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      const percent = total ? Math.floor(received / total * 100) : 0;
      if (total && percent !== lastPercent) {
        lastPercent = percent;
        sendStatus(`Downloading modpack… ${percent}%`, 10 + Math.round(received / total * 35));
      }
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), progress, fs.createWriteStream(destination));
}

async function copyIfPresent(source, destination) {
  try {
    await fsp.access(source);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.cp(source, destination, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function installStagedPack(stage, root, packVersion) {
  const entries = await fsp.readdir(stage, { withFileTypes: true });
  const unexpected = entries.filter(entry => !MANAGED_DIRECTORIES.includes(entry.name) || !entry.isDirectory());
  if (unexpected.length) throw new Error(`The modpack contains an unsupported top-level item: ${unexpected[0].name}`);
  const mods = await fsp.readdir(path.join(stage, 'mods')).catch(() => []);
  if (!mods.some(name => name.toLowerCase().endsWith('.jar'))) throw new Error('The modpack does not contain any active mods.');

  const operationId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const backup = path.join(userData(), 'pack-backups', operationId);
  const personal = path.join(userData(), 'pack-personal', operationId);
  await fsp.mkdir(root, { recursive: true });

  for (const relative of PERSONAL_PATHS) {
    await copyIfPresent(path.join(root, ...relative.split('/')), path.join(personal, ...relative.split('/')));
  }

  let switched = false;
  try {
    await fsp.mkdir(backup, { recursive: true });
    switched = true;
    for (const directory of MANAGED_DIRECTORIES) {
      const current = path.join(root, directory);
      if (fs.existsSync(current)) await fsp.rename(current, path.join(backup, directory));
    }

    for (const directory of MANAGED_DIRECTORIES) {
      const incoming = path.join(stage, directory);
      if (fs.existsSync(incoming)) await fsp.rename(incoming, path.join(root, directory));
    }
    for (const relative of PERSONAL_PATHS) {
      await copyIfPresent(path.join(personal, ...relative.split('/')), path.join(root, ...relative.split('/')));
    }

    await fsp.writeFile(path.join(root, '.bambi-pack.json'), JSON.stringify({ packVersion, installedAt: new Date().toISOString() }, null, 2), 'utf8');
    await fsp.rm(backup, { recursive: true, force: true }).catch(error => writeLog('Old modpack backup could not be removed.', error));
  } catch (error) {
    if (switched) {
      for (const directory of MANAGED_DIRECTORIES) await fsp.rm(path.join(root, directory), { recursive: true, force: true });
      for (const directory of MANAGED_DIRECTORIES) {
        const previous = path.join(backup, directory);
        if (fs.existsSync(previous)) await fsp.rename(previous, path.join(root, directory));
      }
    }
    throw error;
  } finally {
    await fsp.rm(personal, { recursive: true, force: true });
  }
}

async function syncModpack(manifest, root) {
  if (manifest.schemaVersion === 2) return syncFileModpack(manifest, root);
  const stateFile = path.join(root, '.bambi-pack.json');
  if ((await readJson(stateFile, {})).packVersion === manifest.packVersion) return;

  const operationId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const work = path.join(userData(), 'pack-work', operationId);
  const archive = path.join(work, 'pack.zip');
  const stage = path.join(work, 'stage');
  await fsp.mkdir(stage, { recursive: true });

  try {
    sendStatus('Downloading modpack…', 10);
    await downloadModpack(manifest, archive);
    sendStatus('Verifying modpack…', 47);
    const actualHash = await sha256(archive);
    if (actualHash.toLowerCase() !== String(manifest.instanceZipSha256).toLowerCase()) {
      throw new Error('Modpack verification failed. The downloaded ZIP does not match the published SHA-256.');
    }

    sendStatus('Installing modpack…', 52);
    await extract(archive, { dir: path.resolve(stage) });
    await installStagedPack(stage, root, manifest.packVersion);
    sendStatus(`Modpack ${manifest.packVersion} is ready.`, 60, 'success');
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

async function downloadManagedFile(file, destination, progress) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.bambi-download`;
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const hash = crypto.createHash('sha256');
    let received = 0;
    const verify = new Transform({ transform(chunk, _encoding, callback) { received += chunk.length; hash.update(chunk); progress(received); callback(null, chunk); } });
    try {
      const response = await fetchWithRetry(file.url, { headers: { 'User-Agent': launcherUserAgent(), Accept: 'application/octet-stream' } }, 1);
      if (!response.ok || !response.body) throw new Error(`Could not download ${file.path} (${response.status}).`);
      await pipeline(Readable.fromWeb(response.body), verify, fs.createWriteStream(temporary));
      if (received !== Number(file.size)) throw new Error(`${file.path} has an unexpected file size.`);
      if (hash.digest('hex').toLowerCase() !== String(file.sha256).toLowerCase()) throw new Error(`${file.path} failed SHA-256 verification.`);
      await fsp.rm(destination, { force: true });
      await fsp.rename(temporary, destination);
      return;
    } catch (error) {
      lastError = error;
      await fsp.rm(temporary, { force: true });
      if (attempt < 5) await delay(Math.min(8000, 650 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 350));
    }
  }
  throw lastError;
}

async function downloadMinecraftAsset(asset, destination, progress) {
  const temporary = `${destination}.bambi-asset`;
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const hash = crypto.createHash('sha1');
    let received = 0;
    const verify = new Transform({ transform(chunk, _encoding, callback) { received += chunk.length; hash.update(chunk); progress(received); callback(null, chunk); } });
    try {
      const response = await fetchWithRetry(asset.url, { headers: { 'User-Agent': launcherUserAgent(), Accept: 'application/octet-stream' } }, 1);
      if (!response.ok || !response.body) throw new Error(`Minecraft asset download failed (${response.status}).`);
      await pipeline(Readable.fromWeb(response.body), verify, fs.createWriteStream(temporary));
      if (received !== Number(asset.size)) throw new Error(`Minecraft asset ${asset.hash} has an unexpected size.`);
      if (hash.digest('hex').toLowerCase() !== asset.hash.toLowerCase()) throw new Error(`Minecraft asset ${asset.hash} failed SHA-1 verification.`);
      await fsp.rm(destination, { force: true });
      await fsp.rename(temporary, destination);
      return;
    } catch (error) {
      lastError = error;
      await fsp.rm(temporary, { force: true });
      if (attempt < 5) await delay(Math.min(8000, 650 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 350));
    }
  }
  throw lastError;
}

async function ensureMinecraftAssets(version, root) {
  if (!version.assetIndex?.url || !version.assetIndex?.id) throw new Error('Minecraft asset index information is missing.');
  const indexes = path.join(root, 'assets', 'indexes');
  const indexFile = path.join(indexes, `${version.assetIndex.id}.json`);
  await fsp.mkdir(indexes, { recursive: true });

  let indexValid = false;
  if (fs.existsSync(indexFile)) {
    const stat = await fsp.stat(indexFile).catch(() => null);
    indexValid = stat?.isFile() && stat.size === Number(version.assetIndex.size);
    if (indexValid && version.assetIndex.sha1) indexValid = (await hashFile(indexFile, 'sha1')).toLowerCase() === version.assetIndex.sha1.toLowerCase();
  }
  if (!indexValid) {
    sendStatus('Downloading Minecraft asset index…', 72);
    await downloadMinecraftAsset({
      url: version.assetIndex.url,
      hash: version.assetIndex.sha1,
      size: version.assetIndex.size
    }, indexFile, () => {});
  }

  const index = await readJson(indexFile, null);
  if (!index?.objects || typeof index.objects !== 'object') throw new Error('Minecraft asset index is invalid.');
  const unique = new Map();
  for (const value of Object.values(index.objects)) {
    if (!value?.hash || !Number.isFinite(Number(value.size))) continue;
    const hash = String(value.hash).toLowerCase();
    if (!unique.has(hash)) unique.set(hash, { hash, size: Number(value.size) });
  }

  const pending = [];
  for (const asset of unique.values()) {
    const destination = path.join(root, 'assets', 'objects', asset.hash.slice(0, 2), asset.hash);
    const stat = await fsp.stat(destination).catch(() => null);
    if (!stat?.isFile() || stat.size !== asset.size) {
      asset.url = `https://resources.download.minecraft.net/${asset.hash.slice(0, 2)}/${asset.hash}`;
      pending.push({ asset, destination });
    }
  }

  const totalBytes = pending.reduce((sum, entry) => sum + entry.asset.size, 0);
  let downloadedBytes = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(10, pending.length) }, async () => {
    while (cursor < pending.length) {
      const { asset, destination } = pending[cursor++];
      let fileReceived = 0;
      await downloadMinecraftAsset(asset, destination, received => {
        downloadedBytes += received - fileReceived;
        fileReceived = received;
        const percent = totalBytes ? Math.min(100, Math.floor(downloadedBytes / totalBytes * 100)) : 100;
        sendStatus(`Downloading Minecraft assets… ${megabytes(downloadedBytes)} MB / ${megabytes(totalBytes)} MB · ${percent}%`, 72 + Math.round(percent * 0.12));
      });
    }
  });
  await Promise.all(workers);
}

async function ensureDefaultOptionalContent(root) {
  const registry = await loadContentRegistry();
  const pending = [];
  for (const item of registry.items.filter(entry => entry.builtInOptional && entry.enabled)) {
    const stored = contentStorePath(item);
    if (fs.existsSync(stored)) continue;
    const installed = contentTargetPath(root, item);
    if (fs.existsSync(installed) && (await sha256(installed)).toLowerCase() === item.pinnedSha256.toLowerCase()) {
      await fsp.mkdir(path.dirname(stored), { recursive: true });
      await fsp.copyFile(installed, stored);
      continue;
    }
    pending.push({ item, stored });
  }
  const totalBytes = pending.reduce((sum, entry) => sum + Number(entry.item.pinnedSize), 0);
  let downloadedBytes = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, pending.length) }, async () => {
    while (cursor < pending.length) {
      const { item, stored } = pending[cursor++];
      let fileReceived = 0;
      await downloadManagedFile(
        { path: `optional/${item.fileName}`, url: item.pinnedUrl, sha256: item.pinnedSha256, size: item.pinnedSize },
        stored,
        received => {
          downloadedBytes += received - fileReceived;
          fileReceived = received;
          const percent = totalBytes ? Math.min(100, Math.floor(downloadedBytes / totalBytes * 100)) : 100;
          sendStatus(`Downloading optional mods… ${megabytes(downloadedBytes)} MB / ${megabytes(totalBytes)} MB · ${percent}%`, 5 + Math.round(percent * 0.05));
        }
      );
    }
  });
  await Promise.all(workers);
  await saveContentRegistry(registry);
}

async function syncFileModpack(manifest, root) {
  const stateFile = path.join(root, '.bambi-pack.json');
  const previous = await readJson(stateFile, {});
  let damagedManagedJar = false;
  for (const file of manifest.files.filter(entry => String(entry.path).toLowerCase().endsWith('.jar'))) {
    const relative = normalizePackPath(file.path);
    if (!relative || OPTIONAL_CONTENT_PATHS.has(relative.toLowerCase())) continue;
    const target = path.resolve(root, ...relative.split('/'));
    if (fs.existsSync(target) && !(await isReadableZip(target))) {
      await writeLog(`Removed an incomplete managed mod so it can be repaired: ${target}`);
      await fsp.rm(target, { force: true });
      damagedManagedJar = true;
    }
  }
  if (previous.packVersion === manifest.packVersion && previous.schemaVersion === 2 && !damagedManagedJar) return;
  await fsp.mkdir(root, { recursive: true });

  const nextFiles = manifest.files
    .map(file => ({ ...file, path: normalizePackPath(file.path) }))
    .filter(file => !OPTIONAL_CONTENT_PATHS.has(file.path.toLowerCase()));
  const nextPaths = new Set(nextFiles.map(file => file.path.toLowerCase()));
  const previousFiles = Array.isArray(previous.files) ? previous.files : [];
  const userRegistry = await loadContentRegistry();
  await removeDeployedContent(root, userRegistry);
  await saveContentRegistry(userRegistry);

  const downloads = [];
  for (const file of nextFiles) {
    const destination = path.resolve(root, ...file.path.split('/'));
    if (!destination.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`Unsafe modpack path: ${file.path}`);
    let matches = false;
    if (fs.existsSync(destination)) {
      const stat = await fsp.stat(destination);
      if (stat.isFile() && stat.size === Number(file.size)) matches = (await sha256(destination)).toLowerCase() === String(file.sha256).toLowerCase();
    }
    if (!matches) downloads.push({ file, destination });
  }

  const totalBytes = downloads.reduce((sum, item) => sum + Number(item.file.size), 0);
  let downloadedBytes = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(10, downloads.length) }, async () => {
    while (cursor < downloads.length) {
      const { file, destination } = downloads[cursor++];
      let fileReceived = 0;
      sendStatus(`Downloading ${path.basename(file.path)}…`, totalBytes ? 10 + Math.round(downloadedBytes / totalBytes * 45) : 55);
      await downloadManagedFile(file, destination, received => {
        downloadedBytes += received - fileReceived;
        fileReceived = received;
        if (totalBytes) {
          const percent = Math.min(100, Math.floor(downloadedBytes / totalBytes * 100));
          sendStatus(`Downloading update… ${megabytes(downloadedBytes)} MB / ${megabytes(totalBytes)} MB · ${percent}%`, 10 + Math.round(percent * 0.45));
        }
      });
    }
  });
  await Promise.all(workers);

  for (const removed of manifest.removedPaths || []) {
    const relative = normalizePackPath(removed);
    if (!relative || nextPaths.has(relative.toLowerCase()) || OPTIONAL_CONTENT_PATHS.has(relative.toLowerCase())) continue;
    const target = path.resolve(root, ...relative.split('/'));
    if (target.startsWith(`${path.resolve(root)}${path.sep}`)) await fsp.rm(target, { force: true });
  }

  for (const old of previousFiles) {
    const relative = normalizePackPath(old.path);
    if (!relative || nextPaths.has(relative.toLowerCase()) || OPTIONAL_CONTENT_PATHS.has(relative.toLowerCase())) continue;
    const target = path.resolve(root, ...relative.split('/'));
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.existsSync(target)) continue;
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat?.isFile()) continue;
    const unchanged = old.sha256 && stat.size === Number(old.size) && (await sha256(target)).toLowerCase() === String(old.sha256).toLowerCase();
    if (unchanged) await fsp.rm(target, { force: true });
  }

  await fsp.writeFile(stateFile, JSON.stringify({ schemaVersion: 2, packVersion: manifest.packVersion, installedAt: new Date().toISOString(), files: nextFiles.map(({ path: filePath, sha256: hash, size }) => ({ path: filePath, sha256: hash, size })) }, null, 2), 'utf8');
  sendStatus(downloads.length ? `Downloaded ${downloads.length} changed modpack file${downloads.length === 1 ? '' : 's'}.` : 'Modpack files are already up to date.', 60, 'success');
}

async function resolveJava17(candidate) {
  if (!candidate || !fs.existsSync(candidate)) return null;
  const { resolveJava } = await import('@xmcl/installer');
  const info = await resolveJava(candidate).catch(() => undefined);
  return info?.majorVersion === 17 ? candidate : null;
}

async function findExistingJava17() {
  const candidates = [
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'javaw.exe'),
    path.join(userData(), 'runtime', 'java17', 'bin', 'javaw.exe'),
    path.join(process.env.APPDATA || '', 'ModrinthApp', 'meta', 'java_versions', 'zulu17.68.17-ca-jre17.0.20-win_x64', 'bin', 'javaw.exe'),
    path.join(process.env.ProgramFiles || '', 'Eclipse Adoptium', 'jdk-17.0.15.6-hotspot', 'bin', 'javaw.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Minecraft Launcher', 'runtime', 'java-runtime-gamma', 'windows-x64', 'java-runtime-gamma', 'bin', 'javaw.exe')
  ].filter(Boolean);
  for (const candidate of candidates) {
    const java = await resolveJava17(candidate);
    if (java) return java;
  }
  return null;
}

async function ensureJava17() {
  const existing = await findExistingJava17();
  if (existing) return existing;

  sendStatus('Installing the required Java 17 runtime…', 62);
  const runtime = path.join(userData(), 'runtime', 'java17');
  const { fetchJavaRuntimeManifest, installJavaRuntimeTask, JavaRuntimeTargetType } = await import('@xmcl/installer');
  const manifest = await fetchJavaRuntimeManifest({ target: JavaRuntimeTargetType.Gamma });
  const { DefaultRangePolicy } = await import('@xmcl/file-transfer');
  await installJavaRuntimeTask({
    destination: runtime,
    manifest,
    rangePolicy: new DefaultRangePolicy(Number.MAX_SAFE_INTEGER, 1)
  }).startAndWait();
  const java = await resolveJava17(path.join(runtime, 'bin', 'javaw.exe'));
  if (!java) throw new Error('Java 17 was downloaded but could not be validated.');
  return java;
}

function parseServerAddress(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(.+?)(?::(\d{1,5}))?$/);
  return match ? { ip: match[1], ...(match[2] ? { port: Number(match[2]) } : {}) } : undefined;
}

async function hasForgeClientArtifacts(root, minecraftVersion, forgeVersion, forgeId) {
  const versionJson = await readJson(path.join(root, 'versions', forgeId, `${forgeId}.json`), null);
  if (!versionJson) return false;
  const gameArgs = versionJson.arguments?.game || [];
  const mcpIndex = gameArgs.indexOf('--fml.mcpVersion');
  const mcpVersion = mcpIndex >= 0 ? gameArgs[mcpIndex + 1] : null;
  if (!mcpVersion) return false;
  const minecraftClient = `${minecraftVersion}-${mcpVersion}`;
  const required = [
    path.join(root, 'libraries', 'net', 'minecraft', 'client', minecraftClient, `client-${minecraftClient}-srg.jar`),
    path.join(root, 'libraries', 'net', 'minecraft', 'client', minecraftClient, `client-${minecraftClient}-extra.jar`),
    path.join(root, 'libraries', 'net', 'minecraftforge', 'forge', `${minecraftVersion}-${forgeVersion}`, `forge-${minecraftVersion}-${forgeVersion}-client.jar`)
  ];
  let valid = true;
  for (const file of required) {
    if (!fs.existsSync(file)) { valid = false; continue; }
    if (!(await isReadableZip(file))) {
      await writeLog(`Removed an incomplete Forge archive so it can be repaired: ${file}`);
      await fsp.rm(file, { force: true });
      valid = false;
    }
  }
  return valid;
}

async function ensureMinecraft(root, javaPath, minecraftVersion, forgeVersion) {
  const { MinecraftFolder, Version } = await import('@xmcl/core');
  const { installVersion, installForge, installLibraries, getVersionList } = await import('@xmcl/installer');
  const { DefaultRangePolicy } = await import('@xmcl/file-transfer');
  const location = new MinecraftFolder(root);
  const downloadOptions = {
    rangePolicy: new DefaultRangePolicy(Number.MAX_SAFE_INTEGER, 1),
    librariesDownloadConcurrency: 8
  };
  const minecraftJar = path.join(root, 'versions', minecraftVersion, `${minecraftVersion}.jar`);
  if (fs.existsSync(minecraftJar) && !(await isReadableZip(minecraftJar))) {
    await writeLog(`Removed an incomplete Minecraft archive so it can be repaired: ${minecraftJar}`);
    await fsp.rm(minecraftJar, { force: true });
  }
  const needsMinecraft =
    !fs.existsSync(path.join(root, 'versions', minecraftVersion, `${minecraftVersion}.json`)) ||
    !fs.existsSync(minecraftJar);
  if (needsMinecraft) {
    sendStatus('Preparing Minecraft files…', 68);
    await retryOperation('Minecraft installation', async () => {
      const versionList = await getVersionList();
      const versionMeta = versionList.versions.find(version => version.id === minecraftVersion);
      if (!versionMeta) throw new Error(`Minecraft ${minecraftVersion} could not be found.`);
      await installVersion(versionMeta, location, downloadOptions);
    });
  }
  const minecraft = await Version.parse(location, minecraftVersion);
  await ensureMinecraftAssets(minecraft, root);
  sendStatus('Verifying Minecraft libraries…', 85);
  await retryOperation('Minecraft library repair', async () => {
    await installLibraries(minecraft, downloadOptions);
  });

  const forgeId = `${minecraftVersion}-forge-${forgeVersion}`;
  const needsForge = !(await hasForgeClientArtifacts(root, minecraftVersion, forgeVersion, forgeId));
  if (needsForge) {
    sendStatus('Installing or repairing Forge…', 80);
    await retryOperation('Forge installation', async () => {
      await installForge({ mcversion: minecraftVersion, version: forgeVersion }, location, { java: javaPath, side: 'client', ...downloadOptions });
      if (!(await hasForgeClientArtifacts(root, minecraftVersion, forgeVersion, forgeId))) throw new Error('Forge produced an incomplete archive.');
    });
  }
  sendStatus('Verifying Forge libraries…', 88);
  await retryOperation('Forge library repair', async () => {
    await installLibraries(await Version.parse(location, forgeId), downloadOptions);
    if (!(await hasForgeClientArtifacts(root, minecraftVersion, forgeVersion, forgeId))) throw new Error('A Forge library is incomplete.');
  });
  return forgeId;
}

async function launchGame() {
  if (!currentAccount) throw new Error('Sign in with your Microsoft account first.');
  if (minecraftProcess && minecraftProcess.exitCode === null && !minecraftProcess.killed) {
    throw new Error('Minecraft is already running.');
  }
  const settings = await getSettings();
  if (!settings.installationConfigured) throw new Error('Choose an installation folder first.');
  const manifest = await fetchManifest(settings.manifestUrl);
  try {
    await ensureDefaultOptionalContent(settings.instancePath);
    await syncModpack(manifest, settings.instancePath);
  } finally {
    await applyUserContent(settings.instancePath);
  }
  const javaPath = await ensureJava17();
  const forgeId = await ensureMinecraft(
    settings.resourcePath,
    javaPath,
    manifest.minecraftVersion || defaults.minecraftVersion,
    manifest.forgeVersion || defaults.forgeVersion
  );

  sendStatus('Launching Minecraft…', 94);
  const { launch } = await import('@xmcl/core');
  const quickPlayAddress = String(defaults.serverAddress || manifest.serverAddress || '').trim();
  const child = await launch({
    gameProfile: { name: currentAccount.name, id: currentAccount.id },
    accessToken: currentAccount.accessToken,
    userType: 'mojang',
    gamePath: settings.instancePath,
    resourcePath: settings.resourcePath,
    javaPath,
    version: forgeId,
    minMemory: 2048,
    maxMemory: settings.ramMb,
    // Some mods call String.toLowerCase() without Locale.ROOT. On Turkish
    // Windows this turns ASCII I into a dotless ı and creates invalid
    // Minecraft resource identifiers (Easy NPC 5.4.1 is one example).
    extraJVMArgs: ['-Duser.language=en', '-Duser.country=US'],
    ...(quickPlayAddress ? { extraMCArgs: ['--quickPlayMultiplayer', quickPlayAddress] } : {}),
    launcherName: 'Bambi SMP Launcher',
    launcherBrand: 'BambiSMP',
    extraExecOption: { detached: false, stdio: ['ignore', 'pipe', 'pipe'] }
  });
  minecraftProcess = child;
  const childLogPath = path.join(settings.instancePath, 'logs', 'launcher-child.log');
  await fsp.mkdir(path.dirname(childLogPath), { recursive: true });
  const childLog = fs.createWriteStream(childLogPath, { flags: 'a' });
  childLog.write(`\n[${new Date().toISOString()}] Starting Minecraft (pid ${child.pid || 'unknown'})\n`);
  child.stdout?.pipe(childLog, { end: false });
  child.stderr?.pipe(childLog, { end: false });
  child.on('error', error => writeLog('Minecraft process error.', error));
  child.once('exit', async (code, signal) => {
    childLog.end(`\n[${new Date().toISOString()}] Minecraft exited (code ${code}, signal ${signal || 'none'})\n`);
    minecraftProcess = null;
    await writeLog(`Minecraft exited with code ${code}${signal ? ` and signal ${signal}` : ''}.`);
    if (code && code !== 0) sendStatus(`Minecraft closed with error code ${code}. Check launcher-child.log.`, null, 'error');
    else sendStatus('Minecraft closed.', null, 'normal');
  });
  sendStatus('Minecraft is running. Have fun ♡', 100, 'success');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 940,
    minHeight: 620,
    frame: false,
    backgroundColor: '#fff9f7',
    show: false,
    icon: path.join(__dirname, '..', 'assets', 'bambi-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', async () => {
    mainWindow.show();
    if (process.env.BAMBI_SCREENSHOT_PATH) {
      await new Promise(resolve => setTimeout(resolve, 1800));
      const image = await mainWindow.webContents.capturePage();
      await fsp.writeFile(process.env.BAMBI_SCREENSHOT_PATH, image.toPNG());
      app.quit();
    }
  });
}

app.whenReady().then(async () => { await restoreSession(); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
ipcMain.handle('window:minimize', () => mainWindow.minimize());
ipcMain.handle('window:maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('window:close', () => mainWindow.close());
ipcMain.handle('launcher:get-state', async () => ({
  account: currentAccount && { name: currentAccount.name, id: currentAccount.id, avatarUrl: `https://mc-heads.net/avatar/${currentAccount.id}/96` },
  settings: await getSettings(),
  defaults,
  version: app.getVersion()
}));
ipcMain.handle('launcher:save-settings', (_event, next) => saveSettings(next || {}));
ipcMain.handle('launcher:choose-installation', () => chooseInstallationDirectory());
ipcMain.handle('launcher:server-status', () => fetchServerStatus());
ipcMain.handle('launcher:list-content', () => listContent());
ipcMain.handle('launcher:pick-content', (_event, type) => pickLocalContent(type));
ipcMain.handle('launcher:add-content-paths', (_event, paths, type) => registerLocalContent(Array.isArray(paths) ? paths : [], type));
ipcMain.handle('launcher:toggle-content', (_event, id, enabled) => toggleContent(id, enabled));
ipcMain.handle('launcher:remove-content', (_event, id) => removeContent(id));
ipcMain.handle('launcher:search-modrinth', (_event, query, type, offset) => searchModrinth(query, type, offset));
ipcMain.handle('launcher:install-modrinth', (_event, projectId, type) => installModrinthProject(projectId, type));
ipcMain.handle('launcher:open-map', () => shell.openExternal(defaults.mapUrl));
ipcMain.handle('launcher:open-folder', async () => {
  const target = (await getSettings()).instancePath;
  await fsp.mkdir(target, { recursive: true });
  return shell.openPath(target);
});
ipcMain.handle('launcher:logout', async () => {
  currentAccount = null;
  activeXboxSession = null;
  await fsp.rm(authFile(), { force: true });
  return true;
});
ipcMain.handle('launcher:login', async () => {
  try {
    sendStatus('Opening Microsoft sign-in…');
    const manager = new Auth('select_account');
    const xbox = await manager.launch('electron', { width: 520, height: 720 });
    const minecraft = await xbox.getMinecraft();
    await storeRefreshToken(xbox.save());
    activeXboxSession = xbox;
    currentAccount = { name: minecraft.profile.name, id: minecraft.profile.id, accessToken: minecraft.mcToken };
    sendStatus(`Welcome, ${currentAccount.name} ♡`, null, 'success');
    return { name: currentAccount.name, id: currentAccount.id, avatarUrl: `https://mc-heads.net/avatar/${currentAccount.id}/96` };
  } catch (error) {
    await writeLog('Microsoft sign-in failed.', error);
    throw error;
  }
});
ipcMain.handle('launcher:play', async () => {
  try {
    await launchGame();
    return { ok: true };
  } catch (error) {
    await writeLog('Game launch failed.', error);
    const message = error.message || 'Launch failed.';
    sendStatus(message, null, 'error');
    return { ok: false, error: message };
  }
});
