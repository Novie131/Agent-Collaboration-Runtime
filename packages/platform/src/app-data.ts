import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = 'agent-collaboration-runtime';

/**
 * The one place that decides where ACR keeps its data (SPEC §23.1). `ACR_HOME` overrides it
 * (tests, demos, portable installs).
 */
export function getAppDataDirectory(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.ACR_HOME) return env.ACR_HOME;
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), APP);
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', APP);
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), APP);
}

export const projectDataDirectory = (workspaceId: string, env: NodeJS.ProcessEnv = process.env) =>
  join(getAppDataDirectory(env), 'projects', workspaceId);
