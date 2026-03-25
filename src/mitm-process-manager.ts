import { ChildProcess, execSync, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getInitiatorByUrl } from './http-patch';

export class MitmProcessManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private outputChannel: vscode.OutputChannel;
  private buffer: string = '';

  constructor() {
    super();
    this.outputChannel = vscode.window.createOutputChannel('HTTPceptor (mitmproxy)');
  }

  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.on('error', () => resolve(false));
      server.on('listening', () => {
        server.close();
        resolve(true);
      });
      server.listen(port, '127.0.0.1');
    });
  }

  public async findBinary(configuredPath: string): Promise<string | null> {
    // 1. Check user-configured path
    if (configuredPath && configuredPath !== 'mitmdump' && fs.existsSync(configuredPath)) {
      this.outputChannel.appendLine(`Using configured binary: ${configuredPath}`);
      return configuredPath;
    }

    // 2. Check system PATH
    try {
      const command = process.platform === 'win32' ? 'where mitmdump' : 'which mitmdump';
      const systemPath = execSync(command).toString().trim().split('\n')[0];
      if (systemPath && fs.existsSync(systemPath)) {
        this.outputChannel.appendLine(`Found mitmdump on PATH: ${systemPath}`);
        return systemPath;
      }
    } catch (e) {
      // Ignore errors from which/where
    }

    // 3. Check common fallback locations
    const fallbacks = this.getFallbackPaths();
    for (const fallback of fallbacks) {
      if (fs.existsSync(fallback)) {
        this.outputChannel.appendLine(`Found mitmdump in fallback location: ${fallback}`);
        return fallback;
      }
    }

    return null;
  }

  private getFallbackPaths(): string[] {
    const home = os.homedir();
    const paths: string[] = [];

    if (process.platform === 'linux') {
      paths.push(path.join(home, '.local', 'bin', 'mitmdump'));
    } else if (process.platform === 'darwin') {
      paths.push(path.join(home, 'Library', 'Python', '3.9', 'bin', 'mitmdump'));
      paths.push(path.join(home, 'Library', 'Python', '3.10', 'bin', 'mitmdump'));
      paths.push(path.join(home, 'Library', 'Python', '3.11', 'bin', 'mitmdump'));
      paths.push(path.join(home, 'Library', 'Python', '3.12', 'bin', 'mitmdump'));
    } else if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      paths.push(path.join(appData, 'Python', 'Scripts', 'mitmdump.exe'));
    }

    return paths;
  }

  public async start(binary: string, proxyPort: number, bridgeScriptPath: string): Promise<void> {
    if (this.process) {
      vscode.window.showWarningMessage('mitmproxy is already running.');
      return;
    }

    const proxyPortOk = await this.isPortAvailable(proxyPort);
    if (!proxyPortOk) {
      throw new Error(
        `Port ${proxyPort} is already in use. Please change "httpceptor.mitmproxyPort" in settings.`
      );
    }

    const mitmReady = new Promise<void>((resolve, reject) => {
      this.outputChannel.appendLine(
        `Starting mitmdump: ["${binary}", "-s", "${bridgeScriptPath}", "--listen-port", "${proxyPort}"]`
      );

      try {
        const args = [
          '-s',
          bridgeScriptPath,
          '--listen-port',
          proxyPort.toString(),
          '--set',
          'termlog_verbosity=error',
          '--set',
          'connection_strategy=lazy',
          '--ssl-insecure',
        ];

        this.process = spawn(binary, args, {
          // No shell: true here unless we need it, raw spawn is more predictable for absolute paths
          detached: process.platform !== 'win32',
          env: { ...process.env },
        });

        let isReady = false;

        this.process.stdout?.on('data', (chunk) => {
          this.buffer += chunk.toString();
          const lines = this.buffer.split('\n');
          this.buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            try {
              const payload = JSON.parse(trimmedLine);
              // Attach initiator extension name if available
              if (payload.request?.url) {
                const initiator = getInitiatorByUrl(payload.request.url);
                if (initiator) {
                  payload.initiator = initiator;
                }
              }
              this.emit('network-event', payload);

              if (!isReady) {
                isReady = true;
                clearTimeout(timeout);
                this.outputChannel.appendLine('[Ready] First JSON payload received.');
                resolve();
              }
            } catch (e) {
              this.outputChannel.appendLine(`[STDOUT] ${trimmedLine}`);
            }
          }
        });

        // Small delay to assume it's ready if no early exit (but only if stdout didn't trigger it)
        const timeout = setTimeout(() => {
          if (!isReady && this.process) {
            isReady = true;
            this.outputChannel.appendLine('[Ready] Timeout reached, assuming mitmdump is up.');
            resolve();
          }
        }, 3000);

        this.process.stderr?.on('data', (data) => {
          this.outputChannel.append(`[ERROR] ${data.toString()}`);
        });

        this.process.on('close', (code) => {
          this.outputChannel.appendLine(`mitmdump process exited with code ${code}`);
          clearTimeout(timeout);
          this.process = null;
          this.emit('stopped');
          if (!isReady) {
            reject(new Error(`mitmdump exited with code ${code}. Check the Output Channel.`));
          }
        });

        this.process.on('error', (err) => {
          this.outputChannel.appendLine(`Process spawn error: ${err.message}`);
          clearTimeout(timeout);
          this.process = null;
          if (!isReady) {
            reject(err);
          }
        });
      } catch (error: any) {
        this.outputChannel.appendLine(`Critical spawn error: ${error.message}`);
        reject(error);
      }
    });

    await mitmReady;
  }

  public stop(): void {
    if (this.process) {
      this.outputChannel.appendLine('Stopping mitmdump...');
      const pid = this.process.pid;
      if (pid) {
        if (process.platform === 'win32') {
          try {
            execSync(`taskkill /F /T /PID ${pid}`);
          } catch (e) {
            this.process.kill();
          }
        } else {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch (e) {
            try {
              this.process.kill('SIGKILL');
            } catch (e2) {}
          }
        }
      }
      this.process = null;
    }
  }

  public isRunning(): boolean {
    return this.process !== null;
  }

  public dispose(): void {
    this.stop();
    this.outputChannel.dispose();
  }
}
