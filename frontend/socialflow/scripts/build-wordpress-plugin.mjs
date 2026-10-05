// Packs wordpress-plugin/socialflow-auto-share into public/downloads/socialflow-auto-share.zip, the file the
// Automations page offers for download. Runs before the dev server and before every build, so the download is
// always the plugin in this repository. Node's zlib only: a plain zip (deflate, UTF-8 names), nothing to install.
import { deflateRawSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FOLDER = 'socialflow-auto-share';
const source = resolve(here, '../../../wordpress-plugin', FOLDER);
const target = resolve(here, '../public/downloads', `${FOLDER}.zip`);
const TEXT = /\.(php|js|css|txt|md|json|pot)$/i;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function filesIn(dir) {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? filesIn(path) : [path];
    });
}

// A fixed date keeps the zip byte-for-byte the same from one build to the next when the plugin hasn't changed.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const UNIX_FILE = (0o100644 << 16) >>> 0;

const locals = [];
const central = [];
let offset = 0;
for (const path of filesIn(source)) {
  const name = Buffer.from(`${FOLDER}/${relative(source, path).split(sep).join('/')}`, 'utf8');
  // Text files go in with Unix line endings whatever the checkout used.
  const raw = TEXT.test(path) ? Buffer.from(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), 'utf8') : readFileSync(path);
  const packed = deflateRawSync(raw, { level: 9 });
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, name, packed);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE((3 << 8) | 20, 4); // made on Unix
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt16LE(DOS_TIME, 12);
  entry.writeUInt16LE(DOS_DATE, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(packed.length, 20);
  entry.writeUInt32LE(raw.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt32LE(UNIX_FILE, 38);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, name);

  offset += local.length + name.length + packed.length;
}

const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(central.length / 2, 8);
end.writeUInt16LE(central.length / 2, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, Buffer.concat([...locals, directory, end]));
const version = /^\s*\*\s*Version:\s*(\S+)/m.exec(readFileSync(join(source, `${FOLDER}.php`), 'utf8'))?.[1] ?? 'unknown';
console.log(`packed the WordPress plugin ${version}: ${central.length / 2} files, ${offset + directory.length + end.length} bytes -> public/downloads/${FOLDER}.zip`);
