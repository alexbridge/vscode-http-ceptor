import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';

export class CertManager {
  public static getCaCertPath(): string {
    return path.join(os.homedir(), '.mitmproxy', 'mitmproxy-ca-cert.pem');
  }

  public static async ensureCertExists(binary: string): Promise<boolean> {
    const certPath = this.getCaCertPath();
    if (fs.existsSync(certPath)) {
      return true;
    }

    // If cert doesn't exist, run mitmproxy briefly to generate it
    return new Promise((resolve) => {
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Generating mitmproxy CA certificate...',
          cancellable: false,
        },
        async () => {
          const proc = spawn(binary, ['--version']);

          // mitmproxy/mitmweb usually generates certs on startup if missing.
          // We run --version or similar just to trigger the directory creation logic.
          // If that's not enough, we might need to run it for a second then kill it.

          proc.on('close', () => {
            if (fs.existsSync(certPath)) {
              resolve(true);
            } else {
              // Try running it for 2 seconds then killing it
              const runProc = spawn(binary, ['--listen-port', '0']);
              setTimeout(() => {
                runProc.kill();
                resolve(fs.existsSync(certPath));
              }, 2000);
            }
          });

          proc.on('error', () => resolve(false));
        }
      );
    });
  }
}
