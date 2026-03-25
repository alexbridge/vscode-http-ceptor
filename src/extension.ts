import * as vscode from 'vscode';
import * as path from 'path';
import { MitmProcessManager } from './mitm-process-manager';
import { MitmWebviewPanel } from './mitm-webview-panel';
import { CertManager } from './cert-manager';
import { SettingsManager } from './settings-manager';
import { installHttpPatch, removeHttpPatch } from './http-patch';

let processManager: MitmProcessManager;
let isStarting = false;

export function activate(context: vscode.ExtensionContext) {
  processManager = new MitmProcessManager();

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'httpceptor.toggle';
  statusBarItem.tooltip = 'Toggle HTTP Inspector Proxy';
  context.subscriptions.push(statusBarItem);

  const updateStatusBar = () => {
    if (isStarting) {
      statusBarItem.text = `$(broadcast) HTTPceptor: Starting...`;
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    } else if (processManager.isRunning()) {
      statusBarItem.text = `$(broadcast) HTTPceptor: Active`;
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    } else {
      statusBarItem.text = `$(broadcast) HTTPceptor: Off`;
      statusBarItem.backgroundColor = undefined;
      statusBarItem.color = undefined;
    }
    statusBarItem.show();
  };

  updateStatusBar();

  // Forward network events to the webview
  processManager.on('network-event', (payload) => {
    if (MitmWebviewPanel.currentPanel) {
      MitmWebviewPanel.currentPanel.sendNetworkEvent(payload);
    }
  });

  processManager.on('stopped', () => {
    vscode.commands.executeCommand('setContext', 'httpceptor.proxyRunning', false);
    if (MitmWebviewPanel.currentPanel) {
      MitmWebviewPanel.currentPanel.sendProxyStatus(false);
    }
    updateStatusBar();
  });

  const startCommand = vscode.commands.registerCommand('httpceptor.start', async () => {
    if (isStarting || processManager.isRunning()) {
      return;
    }
    isStarting = true;
    updateStatusBar();
    const config = vscode.workspace.getConfiguration('httpceptor');
    const configuredBinary = config.get<string>('mitmBinary') || 'mitmdump';

    const resolvedBinary = await processManager.findBinary(configuredBinary);

    if (!resolvedBinary) {
      const actions = ['How to install', 'Set custom path'];
      const selection = await vscode.window.showErrorMessage(
        'mitmdump not found. Install mitmproxy to use this extension.',
        ...actions
      );

      if (selection === 'How to install') {
        const installInstructions =
          process.platform === 'win32'
            ? 'To install mitmproxy on Windows:\n1. Run: pip install mitmproxy\n2. Add %APPDATA%\\Python\\Scripts to your PATH'
            : 'To install mitmproxy on Linux/macOS:\nRun: pip install mitmproxy';

        vscode.window.showInformationMessage(installInstructions, { modal: true });
      } else if (selection === 'Set custom path') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'httpceptor.mitmBinary');
      }
      return;
    }

    const proxyPort = config.get<number>('mitmproxyPort') || 8080;
    const bridgeScriptPath = path.join(context.extensionPath, 'bridge.py');

    try {
      const certReady = await CertManager.ensureCertExists(resolvedBinary);
      if (!certReady) {
        vscode.window.showErrorMessage('Failed to generate or find mitmproxy CA certificate.');
        return;
      }

      await processManager.start(resolvedBinary, proxyPort, bridgeScriptPath);
      await SettingsManager.injectProxySettings(proxyPort);
      installHttpPatch(proxyPort, processManager['outputChannel']);

      vscode.commands.executeCommand('setContext', 'httpceptor.proxyRunning', true);
      vscode.commands.executeCommand('httpceptor.openPanel');

      if (MitmWebviewPanel.currentPanel) {
        MitmWebviewPanel.currentPanel.sendProxyStatus(true);
      }
      updateStatusBar();
    } catch (err: any) {
      const message = err.message || 'Unknown error starting mitmdump';
      vscode.window.showErrorMessage(`Failed to start mitmdump: ${message}`);
    } finally {
      isStarting = false;
      updateStatusBar();
    }
  });

  const config = vscode.workspace.getConfiguration('httpceptor');
  if (config.get<boolean>('autoStart')) {
    vscode.commands.executeCommand('httpceptor.start');
  }

  const stopCommand = vscode.commands.registerCommand('httpceptor.stop', async () => {
    removeHttpPatch();
    processManager.stop();
    await SettingsManager.removeProxySettings();
    vscode.commands.executeCommand('setContext', 'httpceptor.proxyRunning', false);
    vscode.window.showInformationMessage('mitmproxy stopped.');
    updateStatusBar();
  });

  const toggleCommand = vscode.commands.registerCommand('httpceptor.toggle', () => {
    if (processManager.isRunning()) {
      vscode.commands.executeCommand('httpceptor.stop');
    } else {
      vscode.commands.executeCommand('httpceptor.start');
    }
  });

  const openPanelCommand = vscode.commands.registerCommand('httpceptor.openPanel', () => {
    MitmWebviewPanel.createOrShow(context.extensionUri);
    if (MitmWebviewPanel.currentPanel) {
      MitmWebviewPanel.currentPanel.onReady = () => {
        if (MitmWebviewPanel.currentPanel) {
          MitmWebviewPanel.currentPanel.sendProxyStatus(processManager.isRunning());
        }
      };
    }
  });

  context.subscriptions.push(
    processManager,
    startCommand,
    stopCommand,
    toggleCommand,
    openPanelCommand
  );
}

export function deactivate() {
  removeHttpPatch();
  if (processManager) {
    processManager.stop();
  }
}
