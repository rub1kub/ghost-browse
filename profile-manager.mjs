#!/usr/bin/env node
/**
 * profile-manager.mjs — Cookie & session profile management for ghost-browse
 *
 * Usage:
 *   node profile-manager.mjs list
 *   node profile-manager.mjs save <name>           # save current context state
 *   node profile-manager.mjs load <name>           # use profile in ghost-browse (--profile flag)
 *   node profile-manager.mjs delete <name>
 *   node profile-manager.mjs import-chrome         # import from OpenClaw browser cookies
 *   node profile-manager.mjs export-netscape <name> # export as Netscape cookies.txt
 *   node profile-manager.mjs show <name>            # show cookies in profile
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createDecipheriv, pbkdf2Sync } from 'crypto';
import { chromium } from 'playwright';

const __dir = dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = join(__dir, 'profiles');

const CHROME_COOKIES_DB = '/home/openclawd/.openclaw/browser/openclaw/user-data/Default/Cookies';

function ensureProfilesDir() {
  if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR, { recursive: true });
}

function profilePath(name) {
  return join(PROFILES_DIR, `${name}.json`);
}

// ─── Chrome decryption (Linux: PBKDF2 + AES-128-CBC) ────────────────────────

function decryptChromeValue(encBuf) {
  try {
    if (!encBuf || encBuf.length === 0) return '';
    const prefix = encBuf.slice(0, 3).toString('ascii');
    if (prefix !== 'v10' && prefix !== 'v11') {
      // Plain text
      return encBuf.toString('utf8').replace(/[\x00-\x08\x0b-\x1f]/g, '');
    }
    // Linux Chrome default: key = PBKDF2(password="peanuts", salt="saltysalt", iterations=1, keylen=16, hash=sha1)
    const password = Buffer.from('peanuts');
    const salt = Buffer.from('saltysalt');
    const key = pbkdf2Sync(password, salt, 1, 16, 'sha1');
    const iv = Buffer.alloc(16, ' '); // 16 spaces (0x20)
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false); // manual PKCS7
    const raw = Buffer.concat([decipher.update(encBuf.slice(3)), decipher.final()]);
    // PKCS7 unpad
    const padLen = raw[raw.length - 1];
    if (padLen < 1 || padLen > 16) return raw.toString('utf8').replace(/[\x00-\x08\x0b-\x1f\x7f-\xff]/g, '');
    const result = raw.slice(0, raw.length - padLen).toString('utf8');
    // Validate it's printable ASCII/UTF8
    if (/^[\x20-\x7e\u00a0-\uffff]*$/.test(result)) return result;
    // If garbage, return empty (cookie value decryption failed - OS keychain may be needed)
    return '';
  } catch (e) {
    return ''; // decryption failed
  }
}

// ─── Import from Chrome ───────────────────────────────────────────────────────

async function importFromChrome(filter = null) {
  if (!existsSync(CHROME_COOKIES_DB)) {
    console.error('Chrome cookies DB not found:', CHROME_COOKIES_DB);
    process.exit(1);
  }

  // Copy DB first (Chrome may lock it)
  const tmpDb = '/tmp/ghost-browse-cookies.db';
  execSync(`cp "${CHROME_COOKIES_DB}" "${tmpDb}"`);

  // Read raw cookies
  const raw = execSync(
    `sqlite3 "${tmpDb}" "SELECT host_key, path, is_secure, expires_utc, name, hex(encrypted_value), value, is_httponly, samesite FROM cookies;" --separator '|||'`,
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );

  const cookies = [];
  raw.trim().split('\n').forEach(line => {
    if (!line.trim()) return;
    const [host, path, secure, expires, name, hexEncVal, plainVal, httponly, samesite] = line.split('|||');
    if (!host || !name) return;

    // Apply domain filter
    if (filter && !host.includes(filter)) return;

    let value = plainVal;
    if (!value && hexEncVal) {
      const encBuf = Buffer.from(hexEncVal, 'hex');
      value = decryptChromeValue(encBuf) || '';
    }

    // Chrome stores timestamps as microseconds since 1601-01-01
    // Convert to Unix timestamp in seconds (Playwright expects seconds or -1)
    let expiresUnix = -1;
    if (expires && parseInt(expires) > 0) {
      expiresUnix = Math.floor(parseInt(expires) / 1000000 - 11644473600);
      if (expiresUnix < 0) expiresUnix = -1; // already expired → no expiry
    }
    cookies.push({
      name: name.trim(),
      value: value?.trim() || '',
      domain: host.trim(),
      path: path?.trim() || '/',
      expires: expiresUnix,
      httpOnly: httponly === '1',
      secure: secure === '1',
      sameSite: ['Strict', 'Lax', 'None'][parseInt(samesite)] || 'Lax',
    });
  });

  unlinkSync(tmpDb);
  return cookies;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdList() {
  ensureProfilesDir();
  const files = readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json'));
  if (!files.length) { console.log('No profiles saved yet.'); return; }

  console.log('\n📁 Saved profiles:\n');
  files.forEach(f => {
    const name = f.replace('.json', '');
    try {
      const data = JSON.parse(readFileSync(join(PROFILES_DIR, f), 'utf8'));
      const count = data.cookies?.length || 0;
      const domains = [...new Set(data.cookies?.map(c => c.domain.replace(/^\./, '')) || [])].slice(0, 5);
      console.log(`  📋 ${name}`);
      console.log(`     ${count} cookies | ${domains.join(', ')}`);
      if (data.metadata?.savedAt) console.log(`     Saved: ${new Date(data.metadata.savedAt).toLocaleString()}`);
      console.log();
    } catch {}
  });
}

async function cmdImportChrome(args) {
  const filter = args[0]; // optional domain filter
  const profileName = args[1] || (filter ? filter.replace(/[^a-z0-9]/gi, '-') : 'chrome-all');

  console.log(`\n🔄 Importing from Chrome${filter ? ` (filter: ${filter})` : ' (all)'}...`);

  const cookies = await importFromChrome(filter);

  const domains = [...new Set(cookies.map(c => c.domain.replace(/^\./, '')))];
  console.log(`✅ Found ${cookies.length} cookies across ${domains.length} domains`);

  const interesting = ['x.com', 'twitter.com', 'reddit.com', 'openai.com', 'chatgpt.com', 'google.com', 'polymarket.com'];
  console.log('\nKey sites:');
  interesting.forEach(site => {
    const count = cookies.filter(c => c.domain?.includes(site)).length;
    if (count > 0) console.log(`  ${site}: ${count} cookies`);
  });

  // Save as profile
  ensureProfilesDir();
  const profile = {
    cookies,
    origins: [],
    metadata: {
      source: 'chrome-import',
      filter: filter || 'all',
      savedAt: new Date().toISOString(),
    },
  };
  writeFileSync(profilePath(profileName), JSON.stringify(profile, null, 2));
  console.log(`\n💾 Saved as profile: "${profileName}"`);
  console.log(`   Use: node ghost-browse.mjs fetch "https://x.com" --profile ${profileName}`);
}

async function cmdImportChromeSite(args) {
  // Import specific sites as separate profiles
  const sites = args.length ? args : ['twitter.com', 'x.com', 'reddit.com', 'openai.com', 'chatgpt.com', 'google.com', 'polymarket.com', 'tradingview.com'];
  
  console.log('\n🔄 Importing site-specific profiles from Chrome...\n');
  
  for (const site of sites) {
    const cookies = await importFromChrome(site);
    if (!cookies.length) { console.log(`  ${site}: no cookies`); continue; }
    
    ensureProfilesDir();
    const name = site.replace(/[^a-z0-9]/gi, '-');
    const profile = {
      cookies,
      origins: [],
      metadata: { source: 'chrome-import', site, savedAt: new Date().toISOString() },
    };
    writeFileSync(profilePath(name), JSON.stringify(profile, null, 2));
    console.log(`  ✅ ${site}: ${cookies.length} cookies → profiles/${name}.json`);
  }
  
  console.log('\nDone! Load any profile with: node ghost-browse.mjs fetch <url> --profile <name>');
}

async function cmdShow(args) {
  const name = args[0];
  if (!name) { console.error('Usage: profile-manager show <name>'); process.exit(1); }
  
  const path = profilePath(name);
  if (!existsSync(path)) { console.error(`Profile "${name}" not found`); process.exit(1); }
  
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const cookies = data.cookies || [];
  
  console.log(`\n📋 Profile: ${name} (${cookies.length} cookies)\n`);
  const bySite = {};
  cookies.forEach(c => {
    const domain = c.domain.replace(/^\./, '');
    if (!bySite[domain]) bySite[domain] = [];
    bySite[domain].push(c);
  });
  
  Object.entries(bySite).sort(([a],[b]) => a.localeCompare(b)).forEach(([domain, cooks]) => {
    console.log(`  ${domain}:`);
    cooks.forEach(c => {
      const val = c.value.length > 40 ? c.value.slice(0, 40) + '...' : c.value;
      const valDisplay = c.value ? val : '[empty]';
      console.log(`    ${c.name} = ${valDisplay}`);
    });
  });
}

async function cmdExportNetscape(args) {
  const name = args[0];
  if (!name) { console.error('Usage: profile-manager export-netscape <name>'); process.exit(1); }
  
  const path = profilePath(name);
  if (!existsSync(path)) { console.error(`Profile "${name}" not found`); process.exit(1); }
  
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const cookies = data.cookies || [];
  
  let output = '# Netscape HTTP Cookie File\n# https://curl.se/docs/http-cookies.html\n';
  cookies.forEach(c => {
    const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
    const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expires = c.expires > 0 ? Math.floor(c.expires / 1000) : '0';
    output += `${domain}\t${flag}\t${c.path}\t${secure}\t${expires}\t${c.name}\t${c.value}\n`;
  });
  
  const outPath = join(PROFILES_DIR, `${name}.cookies.txt`);
  writeFileSync(outPath, output);
  console.log(`Exported to: ${outPath}`);
}

async function cmdImportChromeCDP(args) {
  // Most reliable: launch Chrome with the real user-data-dir copy, extract via CDP (fully decrypted)
  const CHROME_USER_DATA = '/home/openclawd/.openclaw/browser/openclaw/user-data';
  const TMP_PROFILE = '/tmp/ghost-browse-cdp-extract';

  console.log('\n🔄 Copying Chrome profile...');
  execSync(`rm -rf "${TMP_PROFILE}" && cp -r "${CHROME_USER_DATA}" "${TMP_PROFILE}"`);

  console.log('🚀 Launching Chrome via CDP...');
  const context = await chromium.launchPersistentContext(
    TMP_PROFILE,
    {
      headless: true,
      executablePath: '/home/openclawd/.openclaw/bin/chrome-xvfb',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    }
  );

  const client = await context.newCDPSession(context.pages()[0] || await context.newPage());
  const { cookies } = await client.send('Network.getAllCookies');

  await context.close();
  execSync(`rm -rf "${TMP_PROFILE}"`);

  console.log(`✅ Extracted ${cookies.length} cookies (fully decrypted)\n`);

  const filterSites = args.length ? args : ['x.com', 'twitter.com', 'reddit.com', 'openai.com', 'chatgpt.com', 'polymarket.com', 'google.com', 'tradingview.com', 'github.com'];

  ensureProfilesDir();
  for (const site of filterSites) {
    const siteCookies = cookies.filter(c => c.domain?.includes(site));
    if (!siteCookies.length) { console.log(`  ${site}: no cookies`); continue; }

    const profile = {
      cookies: siteCookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        expires: c.expires > 0 ? Math.floor(c.expires) : -1,
        httpOnly: c.httpOnly || false,
        secure: c.secure || false,
        sameSite: c.sameSite || 'Lax',
      })),
      origins: [],
      metadata: { source: 'cdp-extract', site, savedAt: new Date().toISOString() },
    };
    const name = site.replace(/[^a-z0-9]/gi, '-');
    writeFileSync(profilePath(name), JSON.stringify(profile, null, 2));
    console.log(`  ✅ ${site}: ${siteCookies.length} cookies → profiles/${name}.json`);
  }

  // Save full profile too
  const fullProfile = {
    cookies: cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain,
      path: c.path || '/', expires: c.expires > 0 ? Math.floor(c.expires) : -1,
      httpOnly: c.httpOnly || false, secure: c.secure || false, sameSite: c.sameSite || 'Lax',
    })),
    origins: [],
    metadata: { source: 'cdp-extract', site: 'all', savedAt: new Date().toISOString() },
  };
  writeFileSync(profilePath('all'), JSON.stringify(fullProfile, null, 2));
  console.log(`  ✅ all: ${cookies.length} cookies → profiles/all.json`);
  console.log('\nUse: node ghost-browse.mjs fetch <url> --profile <name>');
}

async function cmdDelete(args) {
  const name = args[0];
  if (!name) { console.error('Usage: profile-manager delete <name>'); process.exit(1); }
  const path = profilePath(name);
  if (!existsSync(path)) { console.error(`Profile "${name}" not found`); process.exit(1); }
  unlinkSync(path);
  console.log(`Deleted profile: ${name}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv;

const commands = {
  list: cmdList,
  'import-chrome': (a) => cmdImportChrome(a),
  'import-sites': (a) => cmdImportChromeSite(a),
  'import-cdp': (a) => cmdImportChromeCDP(a),  // Recommended: fully decrypted via CDP
  show: cmdShow,
  'export-netscape': cmdExportNetscape,
  delete: cmdDelete,
};

if (!cmd || !commands[cmd]) {
  console.log(`
profile-manager — Cookie & session profiles for ghost-browse

Commands:
  list                              List all saved profiles
  import-chrome [domain] [name]     Import cookies from OpenClaw browser
  import-sites [site1 site2 ...]    Import each site as a separate profile
  show <name>                       Show cookies in a profile
  export-netscape <name>            Export as Netscape cookies.txt
  delete <name>                     Delete a profile

Examples:
  node profile-manager.mjs import-sites
  node profile-manager.mjs import-chrome x.com twitter
  node profile-manager.mjs list
  node profile-manager.mjs show twitter
  
  # Then use in ghost-browse:
  node ghost-browse.mjs fetch "https://x.com/home" --profile twitter
  node ghost-browse.mjs search "elon musk" --profile twitter --engine ddg
`);
  process.exit(0);
}

commands[cmd](args).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
