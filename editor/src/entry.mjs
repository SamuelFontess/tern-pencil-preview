import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

/**
 * Whether the module at `metaUrl` is the program node was started with. Both sides are real paths:
 * node resolves `import.meta.url` through junctions and symlinks but leaves `process.argv[1]` as given.
 * @param {string} metaUrl `import.meta.url` of the calling module
 */
export function isEntry(metaUrl) {
	try {
		return Boolean(process.argv[1])
			&&realpathSync.native(process.argv[1])===realpathSync.native(fileURLToPath(metaUrl));
	} catch {
		return false;
	}
}
