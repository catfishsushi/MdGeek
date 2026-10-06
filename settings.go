package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// Settings that must survive a restart (such as the theme) live in a small JSON file in the
// user's config folder (%APPDATA%\MdGeek\settings.json on Windows), not in the web view's own
// storage, which is not reliably kept between runs.

var settingsMu sync.Mutex

func settingsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "MdGeek", "settings.json"), nil
}

// readSettings returns the saved settings, or an empty map if there are none yet or the file is
// unreadable (a damaged file just means falling back to defaults).
func readSettings() map[string]string {
	settings := map[string]string{}
	path, err := settingsPath()
	if err != nil {
		return settings
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return settings
	}
	_ = json.Unmarshal(data, &settings)
	return settings
}

// GetSetting returns one saved setting, or "" if it was never saved.
func (a *App) GetSetting(key string) string {
	settingsMu.Lock()
	defer settingsMu.Unlock()
	return readSettings()[key]
}

// SetSetting saves one setting.
func (a *App) SetSetting(key string, value string) error {
	settingsMu.Lock()
	defer settingsMu.Unlock()
	path, err := settingsPath()
	if err != nil {
		return err
	}
	settings := readSettings()
	settings[key] = value
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	// Write to a temporary file first so a crash mid-write can't leave a half-written file.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
