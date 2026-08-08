const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const gamesNamesPath = path.join(rootDir, 'gamenames.txt');
const nDir = __dirname;
const outputPath = path.join(nDir, 'gamesData.js');

const appNames = new Set([
  'AI',
  "DON'T YOU LECTURE ME WITH YOUR THIRTY DOLLAR WEBSITE",
  'DOS Wasm X',
  'EmulatorJS',
  'Helios Proxy',
  'Github Search',
  'NautilusOS',
  'Scratch Editor(with turbowarp options)',
  'Pico 8 edu',
  'Ruffle emulator',
  'Sandstone Proxy',
  'Silk',
  'Soundboard'
]);

const appIdentifierAliases = new Set([
  'clai',
  'cldontyoulectureme',
  'cldontyoulectureme.html',
  'cldoswasmx',
  'clemujs',
  'helios-offline (1)',
  'clhelios-offline (1)',
  'clgithhubsearch',
  'nautilusos',
  'clnautilusos',
  'clscratchoptions',
  'clpico8edu',
  'clruffle',
  'sandstone',
  'clsandstone',
  'clsilk',
  'clsoundboard'
]);

function parseGameNames(content) {
  const map = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.includes(':')) continue;

    const colonIndex = line.indexOf(':');
    if (colonIndex < 1) continue;

    const name = line.slice(0, colonIndex).trim();
    const file = line.slice(colonIndex + 1).trim();
    if (!name || !file) continue;

    map.set(file.toLowerCase(), name);
  }
  return map;
}

function nameCandidates(fileName) {
  const lower = fileName.toLowerCase();
  const out = new Set([lower]);

  if (lower.endsWith('.html.html')) {
    out.add(lower.slice(0, -5));
  }

  if (lower.startsWith('cl')) {
    const withoutCl = lower.slice(2);
    out.add(withoutCl);
    if (withoutCl.endsWith('.html.html')) {
      out.add(withoutCl.slice(0, -5));
    }
  }

  return [...out];
}

function resolveName(fileName, nameMap) {
  for (const candidate of nameCandidates(fileName)) {
    if (nameMap.has(candidate)) return nameMap.get(candidate);
  }
  return path.parse(fileName).name;
}

function resolveApp(name, identifier) {
  if (appNames.has(name)) return true;
  return appIdentifierAliases.has(identifier.toLowerCase());
}

function main() {
  const gameNamesContent = fs.readFileSync(gamesNamesPath, 'utf8');
  const nameMap = parseGameNames(gameNamesContent);

  const files = fs
    .readdirSync(nDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => /\.html?$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  const entries = files.map((fileName) => {
    const identifier = path.parse(fileName).name;
    const name = resolveName(fileName, nameMap);
    const entry = {
      name,
      iframe: `/n/${fileName}`,
      identifier
    };
    if (resolveApp(name, identifier)) {
      entry.app = true;
    }
    return entry;
  });

  const formattedEntries = entries
    .map((entry) => {
        const lines = ['    {'];
        lines.push(`        "name": ${JSON.stringify(entry.name)},`);
        lines.push(`        "iframe": ${JSON.stringify(entry.iframe)},`);
        if (entry.app) {
          lines.push(`        "identifier": ${JSON.stringify(entry.identifier)},`);
          lines.push('        "app": true');
        } else {
          lines.push(`        "identifier": ${JSON.stringify(entry.identifier)}`);
        }

      lines.push('    }');
      return lines.join('\r\n');
    })
    .join(',\r\n');

  const output = `let more = [\r\n${formattedEntries}\r\n];\r\n`;
  fs.writeFileSync(outputPath, output, 'utf8');

  const appCount = entries.filter((e) => e.app).length;
  console.log(`Generated ${entries.length} entries in ${outputPath}`);
  console.log(`App entries flagged: ${appCount}`);
}

main();
