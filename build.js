// build.js — Genera le pagine personali dei biglietti da visita.
// Zero dipendenze esterne, usa solo la libreria standard di Node.

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const TEMPLATES_DIR = path.join(ROOT, 'templates');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DIST_DIR = path.join(ROOT, 'dist');

// ───── Helpers ─────

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function monogramFrom(fullName) {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .map(p => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

// Testo dentro l'HTML: un nome con & o < non deve rompere la pagina.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Testo dentro la vCard (RFC 6350 §3.4): \ , ; e a capo vanno protetti.
function escapeVCard(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// Sostituisce i {{segnaposto}}. I valori passano da `escape`, tranne quelli
// elencati in `raw`: blocchi già composti qui sotto, o indirizzi.
function render(template, data, escape, raw = []) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = data[key];
    if (v === undefined || v === null) return '';
    return raw.includes(key) ? String(v) : escape(v);
  });
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function photoExists(slug) {
  const p = path.join(PUBLIC_DIR, 'photos', `${slug}.jpg`);
  return fs.existsSync(p) ? p : null;
}

function photoAsBase64(filepath) {
  const buf = fs.readFileSync(filepath);
  return buf.toString('base64');
}

// vCard PHOTO field requires line folding at 75 chars (RFC 6350)
function foldVCardLine(line) {
  if (line.length <= 75) return line;
  const chunks = [];
  let i = 0;
  while (i < line.length) {
    chunks.push(line.slice(i, i + 75));
    i += 75;
  }
  return chunks.join('\r\n ');
}

// ───── Pezzi della pagina, per persona ─────

function buildPortrait(employee, photoFile) {
  if (photoFile) {
    return `<img class="photo" src="../photos/${escapeHtml(employee.slug)}.jpg" alt="" width="128" height="128">`;
  }
  const mono = employee.monogram || monogramFrom(employee.name);
  return `<span class="photo photo--mono" aria-hidden="true">${escapeHtml(mono)}</span>`;
}

function buildContactRows(employee) {
  const chevron = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5.5 4.5 4.5L8 14.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  function row(label, href, display, external) {
    const target = external ? ' target="_blank" rel="noopener"' : '';
    return `      <a class="row" href="${escapeHtml(href)}"${target}>
        <span><small>${label}</small><span class="val">${escapeHtml(display)}</span></span>
        ${chevron}
      </a>`;
  }

  const rows = [];
  if (employee.phone) {
    const formatted = employee.phone.replace(/^(\+\d{2})(\d{3})(\d{3})(\d{4,})$/, '$1 $2 $3 $4');
    rows.push(row('Telefono', `tel:${employee.phone}`, formatted, false));
  }
  if (employee.email) {
    rows.push(row('Email', `mailto:${employee.email}`, employee.email, false));
  }
  if (employee.linkedin) {
    const handle = employee.linkedin
      .replace(/^https?:\/\/(www\.)?linkedin\.com\//, '')
      .replace(/[?#].*$/, '')
      .replace(/\/$/, '');
    rows.push(row('LinkedIn', employee.linkedin, handle, true));
  }
  if (employee.instagram) {
    const handle = employee.instagram.replace(/^https?:\/\/(www\.)?instagram\.com\//, '@').replace(/\/$/, '');
    rows.push(row('Instagram', employee.instagram, handle, true));
  }
  if (employee.site) {
    const display = employee.site.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    rows.push(row('Sito', employee.site, display, true));
  }
  return rows.join('\n');
}

function buildExtraFields(employee, photoFile) {
  const lines = [];
  if (employee.linkedin) lines.push(`URL;TYPE=LinkedIn:${employee.linkedin}`);
  if (employee.instagram) lines.push(`URL;TYPE=Instagram:${employee.instagram}`);
  if (employee.address) {
    const a = employee.address;
    const parts = [a.street, a.city, '', a.zip, a.country || 'Italia'].map(v => escapeVCard(v || ''));
    lines.push(`ADR;TYPE=WORK:;;${parts.join(';')}`);
  }
  if (photoFile) {
    const b64 = photoAsBase64(photoFile);
    lines.push(foldVCardLine(`PHOTO;ENCODING=b;TYPE=JPEG:${b64}`));
  }
  return lines.join('\r\n');
}

// I dati arrivano da SECAP PRO («Pubblica biglietti», VC4): data/biglietti.json,
// che non si modifica a mano. data/employees.json resta solo come formato di prima.
function readPeople() {
  const generated = path.join(DATA_DIR, 'biglietti.json');
  if (fs.existsSync(generated)) {
    const data = JSON.parse(fs.readFileSync(generated, 'utf-8'));
    if (data.generato_da !== 'SECAP PRO') {
      throw new Error('data/biglietti.json non viene da SECAP PRO: si pubblica da Amministrazione › Persone.');
    }
    return { employees: data.persone || [], retired: data.ritirati || [] };
  }
  const legacy = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'employees.json'), 'utf-8'));
  return { employees: legacy, retired: [] };
}

// ───── Main build ─────

function main() {
  console.log('▸ Reading sources…');
  const brand = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'brand.json'), 'utf-8'));
  const { employees, retired } = readPeople();
  const htmlTpl = fs.readFileSync(path.join(TEMPLATES_DIR, 'index.html'), 'utf-8');
  const homeTpl = fs.readFileSync(path.join(TEMPLATES_DIR, 'home.html'), 'utf-8');
  const vcfTpl = fs.readFileSync(path.join(TEMPLATES_DIR, 'card.vcf'), 'utf-8');

  if (fs.existsSync(DIST_DIR)) fs.rmSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  console.log('▸ Copying public assets…');
  copyDir(PUBLIC_DIR, DIST_DIR);

  console.log(`▸ Building ${employees.length} contact pages…`);
  let withPhoto = 0;
  const slugs = new Set();
  for (const emp of employees) {
    const slug = emp.slug || slugify(emp.name);
    if (slugs.has(slug)) throw new Error(`Slug doppio: ${slug}`);
    slugs.add(slug);
    const parts = emp.name.split(/\s+/);
    const firstName = parts[0] || '';
    const lastName = parts.slice(1).join(' ') || '';
    const photoFile = photoExists(slug);
    if (photoFile) withPhoto++;

    const data = {
      // brand
      brandName: brand.brandName,
      brandSite: brand.brandSite,
      motto: brand.motto || '',

      // person
      slug,
      name: emp.name,
      firstName,
      lastName,
      role: emp.role || '',
      org: emp.org || brand.defaultOrg || brand.brandName,
      phone: emp.phone || '',
      email: emp.email || '',
      site: emp.site || brand.brandSite,

      // derived
      portrait: buildPortrait({ ...emp, slug }, photoFile),
      contactRows: buildContactRows(emp),
      extraFields: buildExtraFields(emp, photoFile)
    };

    const empDir = path.join(DIST_DIR, slug);
    fs.mkdirSync(empDir, { recursive: true });
    fs.writeFileSync(
      path.join(empDir, 'index.html'),
      render(htmlTpl, data, escapeHtml, ['portrait', 'contactRows'])
    );
    // vCard: CRLF (RFC 6350), senza le righe rimaste vuote (es. nessun telefono)
    const vcfOut = render(vcfTpl, data, escapeVCard, ['extraFields', 'phone', 'email', 'site'])
      .split(/\r?\n/)
      .filter(line => line !== '' && !/^[A-Z;=,-]+:$/.test(line))
      .join('\r\n') + '\r\n';
    fs.writeFileSync(path.join(empDir, 'card.vcf'), vcfOut);
  }

  // Pagina principale: aziendale, senza elenco delle persone (VC16)
  const home = {
    ...brand, base: '',
    message: `I biglietti da visita digitali di ${brand.brandName}: ognuno si apre avvicinando il telefono al suo medaglione.`
  };
  fs.writeFileSync(path.join(DIST_DIR, 'index.html'), render(homeTpl, home, escapeHtml));

  // Biglietti ritirati: il tag porta a una pagina neutra, senza dati né vCard (VC6)
  const retiredPage = render(homeTpl, {
    ...brand, base: '../',
    message: `Questo biglietto da visita non è più attivo. Per contattare ${brand.brandName} passa dal sito.`
  }, escapeHtml);
  for (const slug of retired) {
    if (slugs.has(slug) || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(slug)) continue;
    fs.mkdirSync(path.join(DIST_DIR, slug), { recursive: true });
    fs.writeFileSync(path.join(DIST_DIR, slug, 'index.html'), retiredPage);
  }

  // robots.txt
  fs.writeFileSync(path.join(DIST_DIR, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

  console.log(`✓ Built ${employees.length} pages (${withPhoto} with photo), ${retired.length} retired → dist/`);
}

main();
