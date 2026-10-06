package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "MdGeek",
		Width:     1200,
		Height:    800,
		MinWidth:  640,
		MinHeight: 400,
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: localFiles{},
		},
		DragAndDrop: &options.DragAndDrop{EnableFileDrop: true},
		// A second launch (for example, "Open with" on another file) opens that file here instead.
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "7d1f5a52-3c0e-4c0b-9b57-mdgeek-single-instance",
			OnSecondInstanceLaunch: func(data options.SecondInstanceData) {
				if app.ctx == nil {
					return
				}
				runtime.WindowUnminimise(app.ctx)
				runtime.Show(app.ctx)
				runtime.EventsEmit(app.ctx, "open-paths", absExisting(data.Args, data.WorkingDirectory))
			},
		},
		OnStartup:     app.startup,
		OnBeforeClose: app.beforeClose,
		Bind:          []interface{}{app},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
