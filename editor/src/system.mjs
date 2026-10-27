import {win32} from 'node:path';

const TOOLS=Object.freeze({
	whoami:'whoami.exe',
	icacls:'icacls.exe',
	taskkill:'taskkill.exe',
	powershell:'WindowsPowerShell\\v1.0\\powershell.exe',
});

/**
 * Absolute path of a Windows system tool under `%SystemRoot%\System32`, never looked up through PATH: a hostile
 * or merely earlier PATH entry (Git's `usr\bin\whoami.exe`) must not decide which binary reads or protects the registry.
 * @param {keyof typeof TOOLS} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function systemTool(name,env=process.env) {
	if (!Object.hasOwn(TOOLS,name)) throw new Error(`Unknown system tool: ${name}`);
	return win32.join(env.SystemRoot||'C:\\Windows','System32',TOOLS[name]);
}
