import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

export class SettingsManager {
  private static readonly PROXY_URL = 'http.proxy';
  private static readonly PROXY_STRICT_SSL = 'http.proxyStrictSSL';
  private static readonly PROXY_SUPPORT = 'http.proxySupport';
  private static readonly TERMINAL_ENV = 'terminal.integrated.env.';

  public static async injectProxySettings(proxyPort: number): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    const certPath = path.join(os.homedir(), '.mitmproxy', 'mitmproxy-ca-cert.pem');

    // 1. VS Code Internal Proxy Settings (Global)
    await config.update(this.PROXY_URL, proxyUrl, vscode.ConfigurationTarget.Global);
    await config.update(this.PROXY_STRICT_SSL, false, vscode.ConfigurationTarget.Global);
    await config.update(this.PROXY_SUPPORT, 'fallback', vscode.ConfigurationTarget.Global);

    // 2. Terminal & Process Environment (Workspace or Global)
    const platform =
      process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    const envKey = `${this.TERMINAL_ENV}${platform}`;
    const target = vscode.workspace.workspaceFolders
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    const currentEnv = config.get<Record<string, string>>(envKey) || {};
    const updatedEnv = {
      ...currentEnv,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NODE_EXTRA_CA_CERTS: certPath,
    };

    await config.update(envKey, updatedEnv, target);

    // 3. User Guidance for TLS / Certificates
    // Removed reload prompt as it works without reload.
  }

  public static async removeProxySettings(): Promise<void> {
    const config = vscode.workspace.getConfiguration();

    await config.update(this.PROXY_URL, undefined, vscode.ConfigurationTarget.Global);
    await config.update(this.PROXY_STRICT_SSL, undefined, vscode.ConfigurationTarget.Global);
    await config.update(this.PROXY_SUPPORT, undefined, vscode.ConfigurationTarget.Global);

    const platform =
      process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    const envKey = `${this.TERMINAL_ENV}${platform}`;
    const target = vscode.workspace.workspaceFolders
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    const currentEnv = config.get<Record<string, string>>(envKey) || {};
    const envToRemove = ['HTTP_PROXY', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS'];
    const updatedEnv = { ...currentEnv };
    envToRemove.forEach((key) => delete updatedEnv[key]);

    await config.update(envKey, updatedEnv, target);
  }
}
