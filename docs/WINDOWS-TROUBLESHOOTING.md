# Windows Troubleshooting

This guide covers every common Windows setup problem, written for someone who has never used a command line before.

---

## Contents

1. [Installing Node.js on Windows](#1-installing-nodejs-on-windows)
2. [Which terminal should I use?](#2-which-terminal-should-i-use)
3. ["node is not recognised" — fixing your PATH](#3-node-is-not-recognised--fixing-your-path)
4. [PowerShell says "running scripts is disabled"](#4-powershell-says-running-scripts-is-disabled)
5. [npm install errors — EPERM and node-gyp](#5-npm-install-errors--eperm-and-node-gyp)
6. [Quick diagnostic checklist](#6-quick-diagnostic-checklist)

---

## 1. Installing Node.js on Windows

You need **Node.js version 20 or later**. There are two ways to install it.

### Option A — winget (Windows 11, recommended)

`winget` is built into Windows 11. Open **PowerShell** or **Command Prompt** and run:

```
winget install OpenJS.NodeJS.LTS
```

Wait for it to finish, then **close and reopen** your terminal window. Test it:

```
node --version
```

You should see something like `v22.14.0`. If you see 20 or higher, you are ready.

### Option B — Download from nodejs.org

1. Open your browser and go to **nodejs.org**
2. Click the big **"Download Node.js (LTS)"** button — LTS means "Long Term Support", the stable version
3. Run the downloaded `.msi` installer
4. Accept all the defaults — click Next on every screen
5. When it finishes, **close and reopen** your terminal window
6. Test it: type `node --version` and press Enter

> **Important:** Always close and reopen the terminal after installing Node.js. The terminal does not pick up the new installation until you restart it.

---

## 2. Which terminal should I use?

Windows has three common terminals. They all work, but some need an extra step.

### PowerShell (recommended)

The blue or black window you get when you search for "PowerShell" in the Start menu.

- Works well for all commands in this guide
- May need a one-time execution policy change (see [section 4](#4-powershell-says-running-scripts-is-disabled))

To open: press **Windows key**, type `powershell`, click **Windows PowerShell**.

### Command Prompt (cmd)

The older black window with `C:\>`.

- Also works fine
- No execution policy issues

To open: press **Windows key**, type `cmd`, click **Command Prompt**.

### Git Bash

Installed with Git for Windows. Uses Unix-style paths (`/c/Users/...` instead of `C:\Users\...`).

- Works fine for all commands
- Use forward slashes in paths

To open: right-click on the Desktop or a folder and choose **Git Bash Here**.

> **Tip for beginners:** Use **Command Prompt** if you are unsure. It has no execution policy restrictions and path syntax is what you already know from File Explorer.

---

## 3. "node is not recognised" — fixing your PATH

If you type `node --version` and see:

```
'node' is not recognized as an internal or external command
```

or (in PowerShell):

```
node : The term 'node' is not recognized
```

Node.js is installed but Windows cannot find it. Here is how to fix it.

### Step 1 — Find where Node.js is installed

Node.js is usually at one of these locations:

- `C:\Program Files\nodejs\`
- `C:\Users\YourName\AppData\Roaming\npm\`

Open **File Explorer**, navigate to `C:\Program Files\`, and look for a `nodejs` folder.

### Step 2 — Add it to your PATH

1. Press **Windows key**, type `environment variables`, click **Edit the system environment variables**
2. Click the **Environment Variables…** button near the bottom
3. Under **User variables** (the top section), find the row called **Path** and double-click it
4. Click **New** and type: `C:\Program Files\nodejs`
5. Click **OK** on all three windows
6. **Close and reopen** your terminal

### Step 3 — Test again

```
node --version
npm --version
```

Both should now show version numbers.

> **Still not working?** Try restarting your computer. Windows sometimes needs a full restart to apply PATH changes.

---

## 4. PowerShell says "running scripts is disabled"

If you run `npx evernote-to-onenote` in PowerShell and see:

```
evernote-to-onenote.ps1 cannot be loaded because running scripts is disabled on this system.
```

This is a Windows security setting. You can fix it for your user account without affecting system security.

### Fix (one command, one time)

Open PowerShell and run:

```
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

Type `Y` and press Enter when prompted.

This allows scripts downloaded from the internet (signed scripts) and lets you run local scripts — which is what `npx` needs.

> **What this does:** It only changes the policy for your user account (`-Scope CurrentUser`), not for all users or the system. It is the standard setting recommended for developers.

### Alternative — use Command Prompt instead

If you prefer not to change the policy, switch to **Command Prompt** (cmd). It does not have this restriction:

1. Press **Windows key**, type `cmd`, press Enter
2. Run your commands there instead

---

## 5. npm install errors — EPERM and node-gyp

### EPERM (permission denied)

If `npm install -g evernote-to-onenote` fails with:

```
npm error code EPERM
npm error syscall mkdir
npm error path C:\Users\...\node_modules
```

Windows is blocking npm from writing files. Common causes and fixes:

**Fix 1 — Run as Administrator (quickest)**

Right-click on Command Prompt or PowerShell in the Start menu, choose **Run as administrator**, then retry the install command.

**Fix 2 — Antivirus is blocking npm**

Some antivirus programs (especially Windows Defender real-time protection) block npm's rapid file writes. Temporarily pause real-time protection, run the install, then re-enable it.

**Fix 3 — Change npm's global folder to avoid permission issues**

```
mkdir "%USERPROFILE%\npm-global"
npm config set prefix "%USERPROFILE%\npm-global"
```

Then add `%USERPROFILE%\npm-global` to your PATH (follow the steps in [section 3](#3-node-is-not-recognised--fixing-your-path) but add this path instead).

---

### node-gyp errors

If you see output that includes `node-gyp` and lines like:

```
gyp ERR! find VS
gyp ERR! stack Error: Could not find any Visual Studio installation to use
```

This means a native module tried to compile from C++ source. `evernote-to-onenote` does **not** require native modules, so this error likely means the wrong package is being installed, or npm is trying to build an optional dependency.

**Fix — install current Visual Studio Build Tools**

Do not use the old `windows-build-tools` npm package. It is deprecated and often fails on current Windows versions.

1. Download **Build Tools for Visual Studio** from <https://visualstudio.microsoft.com/downloads/>
2. Run the installer
3. Select **Desktop development with C++**
4. Install, then close and reopen your terminal
5. Retry the original install command

If you only see `node-gyp` while installing a different package, check the package name first. `evernote-to-onenote` itself should not need native compilation.

**Alternative — skip optional dependencies**

```
npm install -g evernote-to-onenote --ignore-scripts
```

This skips build steps for optional native modules. The tool will still work.

---

## 6. Quick diagnostic checklist

Run each line in your terminal and confirm the output shown:

| Command | Expected output |
|---|---|
| `node --version` | `v20.x.x` or higher |
| `npm --version` | `10.x.x` or similar |
| `npx --version` | `10.x.x` or similar |
| `evernote-to-onenote --version` | A version number |

If any of these fail, see the relevant section above.

If you have worked through all sections and still have a problem, [open an issue on GitHub](https://github.com/mooja77/evernote-to-onenote/issues) and include:

1. Your Windows version (Settings → System → About → Windows specification)
2. The output of `node --version` and `npm --version`
3. The exact error message (copy and paste the full text)
