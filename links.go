package main

import (
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// File types a link click will never launch. A Markdown file from someone else could link to
// one of these, and opening it would run it.
var runnableTypes = map[string]bool{
	".exe": true, ".com": true, ".bat": true, ".cmd": true, ".msi": true, ".msp": true,
	".ps1": true, ".psm1": true, ".vbs": true, ".vbe": true, ".js": true, ".jse": true,
	".wsf": true, ".wsh": true, ".hta": true, ".scr": true, ".pif": true, ".lnk": true,
	".reg": true, ".cpl": true, ".jar": true, ".sh": true, ".appimage": true, ".desktop": true,
	".url": true, ".application": true, ".appref-ms": true,
}

// OpenLink opens a link clicked in the editor: web and mail links in the default browser or
// mail app, local files and folders in their default app. Markdown files are opened by the
// frontend in a tab, so they don't come here.
func (a *App) OpenLink(target string) error {
	if u, err := url.Parse(target); err == nil {
		switch strings.ToLower(u.Scheme) {
		case "http", "https", "mailto":
			runtime.BrowserOpenURL(a.ctx, target)
			return nil
		}
	}

	p := filepath.Clean(target)
	if !filepath.IsAbs(p) {
		return errors.New("not a web link or a full file path")
	}
	info, err := os.Stat(p)
	if err != nil {
		return errors.New("file not found")
	}
	if !info.IsDir() {
		if runnableTypes[strings.ToLower(filepath.Ext(p))] {
			return errors.New("MdGeek doesn't open programs or scripts from links")
		}
		if goruntime.GOOS != "windows" && info.Mode()&0o111 != 0 {
			return errors.New("MdGeek doesn't open programs or scripts from links")
		}
	}

	var cmd *exec.Cmd
	if goruntime.GOOS == "windows" {
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", p)
	} else {
		cmd = exec.Command("xdg-open", p)
	}
	return cmd.Start()
}
