package main

import (
	"context"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App holds the Go side of MdGeek. Its exported methods are callable from the frontend.
type App struct {
	ctx     context.Context
	closing bool
}

// Entry is one item in the sidebar file tree.
type Entry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
}

// FileData is a file's text plus its modified time, used to spot outside changes.
type FileData struct {
	Content string `json:"content"`
	ModTime int64  `json:"modTime"`
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	// Files dropped onto the window are opened as tabs.
	runtime.OnFileDrop(ctx, func(x, y int, paths []string) {
		runtime.EventsEmit(ctx, "open-paths", paths)
	})

	// The frontend answers "request-close" with "close-ready" once every tab is saved.
	runtime.EventsOn(ctx, "close-ready", func(_ ...interface{}) {
		runtime.Quit(ctx)
	})
}

// beforeClose holds the window open until the frontend has saved everything.
// If the frontend doesn't answer within 3 seconds, the app quits anyway.
func (a *App) beforeClose(ctx context.Context) (prevent bool) {
	if a.closing {
		return false
	}
	a.closing = true
	runtime.EventsEmit(ctx, "request-close")
	go func() {
		time.Sleep(3 * time.Second)
		runtime.Quit(ctx)
	}()
	return true
}

// StartupPaths returns files or folders passed on the command line ("Open with").
func (a *App) StartupPaths() []string {
	return absExisting(os.Args[1:], "")
}

// absExisting makes each path absolute (relative to baseDir if given) and drops ones that don't exist.
func absExisting(args []string, baseDir string) []string {
	out := []string{}
	for _, p := range args {
		if strings.HasPrefix(p, "-") {
			continue
		}
		if !filepath.IsAbs(p) && baseDir != "" {
			p = filepath.Join(baseDir, p)
		}
		abs, err := filepath.Abs(p)
		if err != nil {
			continue
		}
		if _, err := os.Stat(abs); err == nil {
			out = append(out, abs)
		}
	}
	return out
}

func isMarkdown(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".md" || ext == ".markdown"
}

// ListDir returns the subfolders and Markdown files directly inside dir.
func (a *App) ListDir(dir string) ([]Entry, error) {
	items, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	entries := []Entry{}
	for _, it := range items {
		name := it.Name()
		if strings.HasPrefix(name, ".") || name == "node_modules" {
			continue
		}
		full := filepath.Join(dir, name)
		if it.IsDir() {
			entries = append(entries, Entry{Name: name, Path: full, IsDir: true})
		} else if isMarkdown(name) {
			entries = append(entries, Entry{Name: name, Path: full})
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	return entries, nil
}

// IsDir reports whether path is a folder.
func (a *App) IsDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// ReadFile loads a file as text.
func (a *App) ReadFile(path string) (FileData, error) {
	info, err := os.Stat(path)
	if err != nil {
		return FileData{}, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return FileData{}, err
	}
	return FileData{Content: string(b), ModTime: info.ModTime().UnixMicro()}, nil
}

// StatFile returns a file's modified time. The frontend polls this to notice outside edits.
func (a *App) StatFile(path string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.ModTime().UnixMicro(), nil
}

// WriteFile saves text to path and returns the new modified time.
// It writes a temporary file first and then renames it, so a crash can't leave a half-written file.
func (a *App) WriteFile(path string, content string) (int64, error) {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".mdgeek-*.tmp")
	if err != nil {
		return 0, err
	}
	tmpName := tmp.Name()
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return 0, err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return 0, err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return 0, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.ModTime().UnixMicro(), nil
}

// PickFiles shows the "open file" dialog.
func (a *App) PickFiles() ([]string, error) {
	return runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Open Markdown file",
		Filters: []runtime.FileFilter{
			{DisplayName: "Markdown (*.md;*.markdown)", Pattern: "*.md;*.markdown"},
			{DisplayName: "All files", Pattern: "*.*"},
		},
	})
}

// PickFolder shows the "open folder" dialog.
func (a *App) PickFolder() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{Title: "Open folder"})
}

// SaveExport asks where to save an exported file and writes it. Returns "" if the user cancelled.
func (a *App) SaveExport(defaultName string, content string) (string, error) {
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Export",
		DefaultFilename: defaultName,
	})
	if err != nil || path == "" {
		return "", err
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// localFiles serves images that Markdown files reference by relative path.
// The frontend rewrites such image links to /localfile?p=<absolute path>.
// Only image types are served, so this can't be used to read other files.
type localFiles struct{}

var imageTypes = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true,
	".webp": true, ".svg": true, ".bmp": true, ".ico": true, ".avif": true,
}

func (localFiles) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/localfile" {
		http.NotFound(w, r)
		return
	}
	p := filepath.Clean(r.URL.Query().Get("p"))
	ext := strings.ToLower(filepath.Ext(p))
	if !filepath.IsAbs(p) || !imageTypes[ext] {
		http.Error(w, "not an image", http.StatusForbidden)
		return
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeFile(w, r, p)
}
