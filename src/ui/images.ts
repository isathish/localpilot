import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface ImageAttachment {
  name: string;
  /** Base64 PNG/JPEG data (no data: prefix). */
  data: string;
  mime: string;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

export async function pickImages(): Promise<ImageAttachment[]> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: 'Attach image',
    filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
  });
  const out: ImageAttachment[] = [];
  for (const uri of picked ?? []) {
    const img = await readImage(uri.fsPath);
    if (img) {
      out.push(img);
    }
  }
  return out;
}

export async function readImage(fsPath: string): Promise<ImageAttachment | undefined> {
  if (!IMAGE_EXT.test(fsPath)) {
    return undefined;
  }
  try {
    const buf = await fs.readFile(fsPath);
    if (buf.byteLength > 12 * 1024 * 1024) {
      void vscode.window.showWarningMessage(`${path.basename(fsPath)} is larger than 12 MB; skipped.`);
      return undefined;
    }
    const ext = path.extname(fsPath).slice(1).toLowerCase();
    return { name: path.basename(fsPath), data: buf.toString('base64'), mime: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` };
  } catch {
    return undefined;
  }
}

/**
 * Captures a screenshot using the OS tool. On macOS and Linux the user selects a region interactively
 * (the VS Code window stays visible); on Windows the whole primary screen is captured.
 */
export async function captureScreenshot(mode: 'region' | 'window' | 'screen' = 'region'): Promise<ImageAttachment | undefined> {
  const file = path.join(os.tmpdir(), `localpilot-shot-${Date.now()}.png`);
  const run = (cmd: string, args: string[]) =>
    new Promise<boolean>((resolve) => {
      const child = cp.spawn(cmd, args, { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });

  let ok = false;
  if (process.platform === 'darwin') {
    const flag = mode === 'region' ? '-i' : mode === 'window' ? '-iW' : '';
    ok = await run('screencapture', [...(flag ? [flag] : []), '-x', file]);
  } else if (process.platform === 'linux') {
    const candidates: [string, string[]][] =
      mode === 'screen'
        ? [['gnome-screenshot', ['-f', file]], ['spectacle', ['-f', '-b', '-n', '-o', file]], ['scrot', [file]], ['grim', [file]]]
        : [['gnome-screenshot', ['-a', '-f', file]], ['spectacle', ['-r', '-b', '-n', '-o', file]], ['scrot', ['-s', file]], ['sh', ['-c', `grim -g "$(slurp)" ${JSON.stringify(file)}`]]];
    for (const [cmd, args] of candidates) {
      if (await run(cmd, args)) {
        ok = true;
        break;
      }
    }
  } else if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${file.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`;
    ok = await run('powershell', ['-NoProfile', '-Command', ps]);
  }
  if (!ok) {
    return undefined;
  }
  try {
    const img = await readImage(file);
    await fs.unlink(file).catch(() => undefined);
    return img ? { ...img, name: `screenshot-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png` } : undefined;
  } catch {
    return undefined;
  }
}
