// Builds the backend a sync config names (design §14.5), with credentials from the SecretBox. Pure Node.
import type { SecretBox } from '../../data/crypto/secretBox';
import { BackendError, SyncBackend, SyncBackendConfig } from './backend';
import { FolderBackend } from './folder';
import { GitBackend } from './git';
import { S3Backend } from './s3';
import { WebDavBackend } from './webdav';

/** What the factory needs besides the config: where secrets live, a fetch (tests), git, a working folder. */
export interface BackendDeps {
  secrets: SecretBox;
  /** Secret names: `<remote>` scope keys are per backend config, not per remote id (credentials exist before the remote). */
  fetch?: typeof fetch;
  gitPath?: string;
  /** `<dataRoot>/sync`: the git backend's working clone lives under it. */
  workDir: string;
  /** This device's name (git commit messages). */
  deviceName?: string;
}

/** SecretBox names of backend credentials (never in settings). */
export const SECRET_NAMES = {
  s3Secret: 'localpilot.sync.s3.secretAccessKey',
  webdavPassword: 'localpilot.sync.webdav.password',
  webdavToken: 'localpilot.sync.webdav.token',
} as const;

/** Builds the backend a config names. Throws BackendError('other') for an incomplete config. */
export async function createBackend(cfg: SyncBackendConfig, deps: BackendDeps): Promise<SyncBackend> {
  switch (cfg.kind) {
    case 'folder': {
      if (!cfg.folder?.path) {
        throw new BackendError('other', 'Choose a folder to sync with');
      }
      return new FolderBackend(cfg.folder.path);
    }
    case 'git': {
      if (!cfg.git?.url) {
        throw new BackendError('other', 'Enter the URL of the Git repository to sync with');
      }
      return new GitBackend({ url: cfg.git.url, branch: cfg.git.branch || 'localpilot-sync', workDir: deps.workDir, git: deps.gitPath, deviceName: deps.deviceName });
    }
    case 's3': {
      const s = cfg.s3;
      if (!s?.endpoint || !s.bucket || !s.accessKeyId) {
        throw new BackendError('other', 'Enter the endpoint, bucket and access key of the S3-compatible storage');
      }
      const secret = await deps.secrets.get(SECRET_NAMES.s3Secret);
      if (!secret) {
        throw new BackendError('auth', 'The secret access key is not set on this device');
      }
      return new S3Backend({ ...s, secretAccessKey: secret, fetch: deps.fetch });
    }
    case 'webdav': {
      const w = cfg.webdav;
      if (!w?.url) {
        throw new BackendError('other', 'Enter the WebDAV URL');
      }
      const password = await deps.secrets.get(SECRET_NAMES.webdavPassword);
      const token = await deps.secrets.get(SECRET_NAMES.webdavToken);
      return new WebDavBackend({ url: w.url, username: w.username, password, token, fetch: deps.fetch });
    }
  }
}
