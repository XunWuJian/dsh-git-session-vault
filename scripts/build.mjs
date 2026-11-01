/**
 * Host build: `src/**\/*.js` -> `lib/**\/*.js`.
 *
 * The host half is plain ESM with no bare imports, so the "build" is a copy
 * plus a light syntax check. Keeping it a separate step from the browser
 * bundle means `npm run build` reproduces exactly what is published.
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('.', import.meta.url)));
const sourceDir = join(root, 'src');
const targetDir = join(root, 'lib');

/** Every `.js` file under `directory`, recursively. */
async function collect(directory) {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
            found.push(...await collect(full));
            continue;
        }
        if (entry.isFile() && entry.name.endsWith('.js'))
            found.push(full);
    }
    return found;
}

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });

const files = await collect(sourceDir);
for (const file of files) {
    const target = join(targetDir, relative(sourceDir, file));
    await mkdir(dirname(target), { recursive: true });
    await cp(file, target);
}

const bytes = (await Promise.all(files.map(async file => (await stat(file)).size)))
    .reduce((sum, size) => sum + size, 0);

console.log(`build:host  ${files.length} modules -> lib/  (${(bytes / 1024).toFixed(1)} KiB)`);
