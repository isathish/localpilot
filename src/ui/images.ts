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

export type ScreenshotMode = 'region' | 'window' | 'vscode' | 'screen';

export interface ScreenshotOptions {
  /** Wait before capturing so the user can switch windows / open menus. */
  delayMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function run(cmd: string, args: string[], captureStdout = false): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    const child = cp.spawn(cmd, args, { stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'ignore'] });
    child.stdout?.on('data', (d) => (out += String(d)));
    child.on('error', () => resolve({ ok: false, out }));
    child.on('close', (code) => resolve({ ok: code === 0, out }));
  });
}

/** CGWindowID of the frontmost VS Code window (macOS). Does not need screen-recording permission. */
async function macVscodeWindowId(): Promise<string | undefined> {
  const owners = JSON.stringify([vscode.env.appName, 'Code', 'Code - Insiders', 'Visual Studio Code', 'VSCodium', 'Code - OSS', 'Cursor']);
  const jxa = `ObjC.import('CoreGraphics');
var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0))) || [];
var owners = ${owners};
var w = list.filter(function (x) { return x.kCGWindowLayer === 0 && owners.indexOf(x.kCGWindowOwnerName) >= 0 && x.kCGWindowBounds && x.kCGWindowBounds.Width > 200; })[0];
w ? String(w.kCGWindowNumber) : '';`;
  const r = await run('osascript', ['-l', 'JavaScript', '-e', jxa], true);
  const id = r.out.trim();
  return r.ok && /^\d+$/.test(id) ? id : undefined;
}

function winPowershell(script: string): Promise<{ ok: boolean; out: string }> {
  return run('powershell', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
}

/** PowerShell: save a bitmap of `rect` (variables $x,$y,$w,$h) to `file`. */
const winSaveRect = (file: string) =>
  `$bmp=New-Object System.Drawing.Bitmap $w,$h; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($x,$y,0,0,$bmp.Size); $bmp.Save('${file.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`;

const winForegroundRect = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public static class W { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); }
"@
$r = New-Object RECT; [void][W]::GetWindowRect([W]::GetForegroundWindow(), [ref]$r)
$x=$r.L; $y=$r.T; $w=$r.R-$r.L; $h=$r.B-$r.T; if ($w -lt 2 -or $h -lt 2) { exit 2 }
`;

/** Full-screen translucent overlay; drag to select, Esc cancels. Sets $x,$y,$w,$h. */
const winRegionPicker = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen
$f=New-Object System.Windows.Forms.Form
$f.FormBorderStyle='None'; $f.StartPosition='Manual'; $f.Bounds=$vs; $f.TopMost=$true; $f.Opacity=0.3; $f.BackColor='Black'; $f.Cursor='Cross'; $f.ShowInTaskbar=$false; $f.KeyPreview=$true
$script:s=$null; $script:r=$null
$f.Add_MouseDown({ $script:s=$_.Location })
$f.Add_MouseMove({ if ($script:s) { $script:r=New-Object System.Drawing.Rectangle ([Math]::Min($script:s.X,$_.X)),([Math]::Min($script:s.Y,$_.Y)),([Math]::Abs($_.X-$script:s.X)),([Math]::Abs($_.Y-$script:s.Y)); $f.Invalidate() } })
$f.Add_Paint({ if ($script:r) { $_.Graphics.FillRectangle([System.Drawing.Brushes]::White,$script:r); $_.Graphics.DrawRectangle([System.Drawing.Pens]::DodgerBlue,$script:r) } })
$f.Add_MouseUp({ $f.Close() })
$f.Add_KeyDown({ if ($_.KeyCode -eq 'Escape') { $script:r=$null; $f.Close() } })
[void]$f.ShowDialog(); $f.Dispose()
if (-not $script:r -or $script:r.Width -lt 2 -or $script:r.Height -lt 2) { exit 2 }
Start-Sleep -Milliseconds 200
$x=$vs.X+$script:r.X; $y=$vs.Y+$script:r.Y; $w=$script:r.Width; $h=$script:r.Height
`;

const winFullScreen = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen; $x=$vs.X; $y=$vs.Y; $w=$vs.Width; $h=$vs.Height
`;

/**
 * Captures a screenshot with the OS tooling.
 * - `region`: drag a rectangle (macOS `screencapture -i`, Linux area tools, Windows overlay picker).
 * - `vscode`: the current VS Code window, without any interaction.
 * - `window`: pick another window (macOS/Linux interactive; Windows captures the foreground window after the delay).
 * - `screen`: the whole screen, optionally after a delay.
 */
export async function captureScreenshot(mode: ScreenshotMode = 'region', opts: ScreenshotOptions = {}): Promise<ImageAttachment | undefined> {
  const file = path.join(os.tmpdir(), `localpilot-shot-${Date.now()}.png`);
  const delay = Math.max(0, opts.delayMs ?? 0);
  let ok = false;

  if (process.platform === 'darwin') {
    if (mode === 'vscode') {
      const id = await macVscodeWindowId();
      if (delay) {
        await sleep(delay);
      }
      ok = id ? (await run('screencapture', ['-x', '-o', '-l', id, file])).ok : (await run('screencapture', ['-x', file])).ok;
    } else {
      if (delay) {
        await sleep(delay);
      }
      const flags = mode === 'region' ? ['-i'] : mode === 'window' ? ['-i', '-W', '-o'] : [];
      ok = (await run('screencapture', [...flags, '-x', file])).ok;
    }
  } else if (process.platform === 'linux') {
    if (delay) {
      await sleep(delay);
    }
    const byMode: Record<ScreenshotMode, [string, string[]][]> = {
      screen: [['gnome-screenshot', ['-f', file]], ['spectacle', ['-f', '-b', '-n', '-o', file]], ['scrot', [file]], ['grim', [file]]],
      region: [['gnome-screenshot', ['-a', '-f', file]], ['spectacle', ['-r', '-b', '-n', '-o', file]], ['scrot', ['-s', '-f', file]], ['sh', ['-c', `grim -g "$(slurp)" ${JSON.stringify(file)}`]]],
      // active window == the VS Code window the user is in
      vscode: [['gnome-screenshot', ['-w', '-f', file]], ['spectacle', ['-a', '-b', '-n', '-o', file]], ['scrot', ['-u', file]], ['sh', ['-c', `import -window "$(xdotool getactivewindow)" ${JSON.stringify(file)}`]]],
      window: [['spectacle', ['-a', '-b', '-n', '-o', file]], ['gnome-screenshot', ['-w', '-f', file]], ['sh', ['-c', `import -window "$(xdotool selectwindow)" ${JSON.stringify(file)}`]], ['scrot', ['-s', '-f', file]]],
    };
    for (const [cmd, args] of byMode[mode]) {
      if ((await run(cmd, args)).ok) {
        ok = true;
        break;
      }
    }
  } else if (process.platform === 'win32') {
    if (delay) {
      await sleep(delay);
    }
    const head = mode === 'region' ? winRegionPicker : mode === 'screen' ? winFullScreen : winForegroundRect;
    ok = (await winPowershell(head + winSaveRect(file))).ok;
  }

  if (!ok) {
    return undefined;
  }
  try {
    const img = await readImage(file);
    await fs.unlink(file).catch(() => undefined);
    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    return img ? { ...img, name: `${mode === 'vscode' ? 'vscode' : mode}-${stamp}.png` } : undefined;
  } catch {
    return undefined;
  }
}
