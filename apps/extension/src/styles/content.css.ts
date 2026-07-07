export const CONTENT_STYLES = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.ma-root { position: fixed; inset: 0; z-index: 2147483600; pointer-events: none; font-family: Inter, Arial, Helvetica, sans-serif; color: #e9edef; font-size: 13px; }
button, input, select { font: inherit; }
.ma-toolbar { position: fixed; z-index: 15; min-height: 29px; padding: 0; display: flex; align-items: flex-start; gap: 3px; overflow: visible; border: 0; border-radius: 0; background: transparent; box-shadow: none; pointer-events: auto; scrollbar-width: none; contain: layout paint style; }
.ma-toolbar::-webkit-scrollbar { display: none; }
.ma-tool-btn, .ma-profile-btn, .ma-toolbar-control, .ma-profile-select { position: relative; height: 23px; display: inline-flex; align-items: center; justify-content: center; gap: 3px; flex: none; border: 1px solid rgba(255,255,255,.14); border-radius: 7px; color: #edf4f4; background: #1f2c33; box-shadow: 0 1px 3px rgba(0,0,0,.16); cursor: pointer; }
.ma-tool-btn { min-width: 23px; padding: 0 3px; }
.ma-tool-btn > span { font-size: 9.5px; font-weight: 650; white-space: nowrap; }
.ma-tool-btn:hover, .ma-profile-btn:hover, .ma-toolbar-control:hover, .ma-profile-select:hover { color: white; background: #263942; }
.ma-tool-btn:disabled, .ma-profile-btn:disabled, .ma-toolbar-control:disabled, .ma-profile-select:disabled { opacity: .45; cursor: wait; }
.ma-toolbar.icons-only .ma-tool-btn { width: 23px; padding: 0; }
.ma-toolbar.icons-only .ma-tool-btn > span { display: none; }
.ma-toolbar-start { width: 86px; padding: 4px; display: grid; gap: 4px; flex: none; border: 1px solid rgba(255,255,255,.055); border-radius: 12px; background: rgba(17,27,33,.18); box-shadow: 0 1px 7px rgba(0,0,0,.12); backdrop-filter: blur(2px); }
.ma-toolbar-controls { display: inline-flex; align-items: center; gap: 3px; }
.ma-tool-strip { min-height: 39px; padding: 4px; display: inline-flex; align-items: center; gap: 2px; flex: none; border: 1px solid rgba(255,255,255,.055); border-radius: 11px; background: rgba(17,27,33,.14); box-shadow: 0 1px 7px rgba(0,0,0,.12); backdrop-filter: blur(2px); }
.ma-pipeline-rail { display: grid; gap: 3px; width: 72px; max-height: 132px; overflow-y: auto; scrollbar-width: none; }
.ma-pipeline-rail::-webkit-scrollbar { display: none; }
.ma-profile-btn { width: 72px; max-width: 72px; height: 23px; padding: 0 4px; border: 1px solid rgba(0,168,132,.45); background: #0c6f60; color: #e9fff9; }
.ma-profile-select { width: 72px; height: 23px; padding: 0 4px; color: #e9fff9; border-color: rgba(0,168,132,.45); background: #0c6f60; font-size: 9.5px; font-weight: 700; outline: none; }
.ma-toolbar-control { width: 23px; padding: 0; cursor: grab; }
.ma-toolbar-control.locked { border-color: rgba(0,168,132,.5); color: #e9fff9; background: #0c6f60; cursor: pointer; }
.ma-toolbar-control.disabled { cursor: not-allowed; }
.ma-toolbar-control.muted { border-color: rgba(255,255,255,.2); color: #ffdadb; background: #4b2529; cursor: pointer; }
.ma-toolbar.ui-hidden { max-width: 92px !important; }
.ma-toolbar.ui-hidden .ma-toolbar-start { width: 86px; }
.ma-button-group { min-height: 24px; padding: 0; display: inline-flex; align-items: center; gap: 1px; flex: none; border: 0; border-radius: 8px; background: transparent; }
.ma-button-group .ma-tool-btn { height: 23px; border-color: rgba(0,168,132,.35); background: #1f2c33; }
.ma-button-group .ma-tool-btn:hover { background: #263942; }
.ma-toolbar.icons-only .ma-button-group .ma-tool-btn { width: 23px; padding: 0; }
.ma-profile-btn span { max-width: 44px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9.5px; font-weight: 800; }
.ma-profile-btn b { min-width: 23px; padding: 2px 4px; border-radius: 999px; background: rgba(255,255,255,.1); font-size: 9px; }
.ma-count { min-width: 17px; height: 17px; padding: 0 4px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; background: #00a884; color: white; font-size: 9px; font-weight: 800; }
.ma-toolbar.icons-only .ma-count { position: absolute; right: -2px; top: -3px; }
.ma-rotate-btn { position: fixed; z-index: 15; min-width: 68px; height: 68px; padding: 0 10px; border: 0; border-radius: 999px; display: flex; align-items: center; justify-content: center; gap: 6px; color: white; background: rgba(17,27,33,.9); box-shadow: 0 5px 18px rgba(0,0,0,.3); pointer-events: auto; cursor: pointer; }
.ma-rotate-btn svg { width: 42px; height: 42px; }
.ma-rotate-btn span { position: absolute; top: 80px; width: max-content; padding: 4px 7px; border-radius: 5px; background: rgba(17,27,33,.92); color: #d8e1e4; font-size: 9px; opacity: 0; transform: translateY(-3px); transition: .12s; pointer-events: none; }
.ma-rotate-btn:hover { background: rgba(0,168,132,.35); }
.ma-rotate-btn:hover span { opacity: 1; transform: translateY(0); }
.ma-live-preview { position: fixed; z-index: 1; object-fit: contain; pointer-events: none; }
.ma-floating-panel { z-index: 16; pointer-events: auto; }
.ma-quick-panel { width: 280px; padding: 11px; border-radius: 11px; background: rgba(17,27,33,.98); border: 1px solid rgba(255,255,255,.1); box-shadow: 0 12px 35px rgba(0,0,0,.45); pointer-events: auto; }
.ma-quick-panel header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.ma-quick-panel header strong { font-size: 12px; }
.ma-icon-btn { width: 30px; height: 30px; border: 0; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; color: #dce4e7; background: transparent; cursor: pointer; }
.ma-icon-btn:hover { background: rgba(255,255,255,.09); }
.ma-mini-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.ma-mini-grid label, .ma-merge-settings label { display: flex; flex-direction: column; gap: 5px; color: #9fb0b8; font-size: 9.5px; font-weight: 650; }
.ma-mini-grid input, .ma-mini-grid select, .ma-merge-settings input, .ma-merge-settings select { width: 100%; height: 34px; padding: 0 9px; border: 1px solid rgba(255,255,255,.11); border-radius: 7px; background: #202c33; color: white; outline: none; }
.ma-mini-grid input:focus, .ma-mini-grid select:focus, .ma-merge-settings input:focus, .ma-merge-settings select:focus { border-color: #00a884; box-shadow: 0 0 0 2px rgba(0,168,132,.13); }
.ma-single-field { display: flex; flex-direction: column; gap: 5px; color: #9fb0b8; font-size: 9.5px; font-weight: 650; }
.ma-single-field input, .ma-single-field select { width: 100%; height: 34px; padding: 0 9px; border: 1px solid rgba(255,255,255,.11); border-radius: 7px; background: #202c33; color: white; outline: none; }
.ma-single-field input:focus, .ma-single-field select:focus { border-color: #00a884; box-shadow: 0 0 0 2px rgba(0,168,132,.13); }
.ma-panel-note { margin: 9px 0 0; color: #8696a0; font-size: 9px; line-height: 1.45; }
.ma-panel-actions { display: flex; justify-content: flex-end; gap: 7px; margin-top: 10px; }
.ma-compact-btn { min-height: 34px; padding: 0 11px; border: 1px solid rgba(255,255,255,.11); border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; color: #eef4f1; background: #202c33; cursor: pointer; }
.ma-compact-btn:hover { background: #2a3941; }
.ma-compact-btn.primary { border-color: #00a884; background: #00a884; color: white; font-weight: 700; }
.ma-compact-btn.danger { color: #ffb4b7; }
.ma-compact-btn:disabled { opacity: .45; cursor: wait; }
.ma-crop-mask { position: fixed; inset: 0; z-index: 8; background: rgba(0,0,0,.16); pointer-events: auto; }
.ma-crop-box { position: fixed; border: 2px solid #00d6a3; box-shadow: 0 0 0 9999px rgba(0,0,0,.58); cursor: move; touch-action: none; }
.ma-crop-box::before, .ma-crop-box::after { content: ''; position: absolute; pointer-events: none; }
.ma-crop-box::before { inset: 33.333% 0 auto; border-top: 1px solid rgba(255,255,255,.5); box-shadow: 0 calc(var(--crop-height, 100px)/3) 0 rgba(255,255,255,.5); }
.ma-crop-box::after { top: 0; bottom: 0; left: 33.333%; border-left: 1px solid rgba(255,255,255,.5); box-shadow: calc(var(--crop-width, 100px)/3) 0 0 rgba(255,255,255,.5); }
.ma-handle { position: absolute; width: 16px; height: 16px; border: 3px solid #00d6a3; background: #111b21; border-radius: 3px; }
.ma-handle.nw { left: -9px; top: -9px; cursor: nwse-resize; }
.ma-handle.ne { right: -9px; top: -9px; cursor: nesw-resize; }
.ma-handle.sw { left: -9px; bottom: -9px; cursor: nesw-resize; }
.ma-handle.se { right: -9px; bottom: -9px; cursor: nwse-resize; }
.ma-crop-controls { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 8px; border-radius: 11px; background: rgba(17,27,33,.98); box-shadow: 0 10px 28px rgba(0,0,0,.4); max-width: 95vw; }
.ma-preset-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; justify-content: center; }
.ma-chip { min-width: 40px; height: 30px; padding: 0 11px; border: 1px solid rgba(255,255,255,.14); border-radius: 999px; color: #cde0e8; background: #1f2c33; font-size: 10.5px; font-weight: 700; cursor: pointer; transition: all .12s; }
.ma-chip:hover { background: #263942; color: white; }
.ma-chip.active { border-color: #00a884; background: rgba(0,168,132,.18); color: #00d6a3; }
.ma-crop-actions { display: flex; align-items: center; gap: 7px; }
.ma-compact-select { height: 34px; max-width: 180px; padding: 0 9px; border: 1px solid rgba(255,255,255,.11); border-radius: 7px; color: white; background: #202c33; outline: none; }
.ma-backdrop { position: fixed; inset: 0; z-index: 5; padding: 22px; display: flex; align-items: center; justify-content: center; background: rgba(3,10,12,.75); backdrop-filter: blur(4px); pointer-events: auto; }
.ma-modal { width: min(1240px, 97vw); max-height: 94vh; overflow: auto; border: 1px solid rgba(255,255,255,.1); border-radius: 14px; background: #111b21; box-shadow: 0 24px 80px rgba(0,0,0,.6); }
.ma-modal-head { position: sticky; top: 0; z-index: 7; min-height: 64px; padding: 13px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid rgba(255,255,255,.08); background: rgba(17,27,33,.98); }
.ma-modal-head h2 { margin: 0; font-size: 17px; }
.ma-modal-head p { margin: 3px 0 0; color: #8696a0; font-size: 10px; }
.ma-modal-body { padding: 16px; }
.ma-modal-actions { position: sticky; bottom: 0; z-index: 7; min-height: 58px; padding: 11px 16px; display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid rgba(255,255,255,.08); background: rgba(17,27,33,.98); }
.ma-workspace-grid { display: grid; grid-template-columns: minmax(440px, 1fr) 310px; gap: 16px; align-items: start; }
.ma-a4-stage { min-width: 0; padding: 12px; display: flex; flex-direction: column; align-items: center; gap: 9px; border: 1px solid rgba(255,255,255,.08); border-radius: 11px; background: #0b1419; }
.ma-a4-page { width: min(100%, 520px); aspect-ratio: 210 / 297; display: grid; overflow: hidden; box-shadow: 0 15px 38px rgba(0,0,0,.42); }
.ma-a4-page.grid { grid-auto-rows: minmax(0,1fr); }
.ma-a4-cell { position: relative; min-width: 0; min-height: 0; overflow: hidden; border-style: solid; background: rgba(223,228,231,.15); }
.ma-pdf-pages { width: min(100%, 520px); min-height: 360px; padding: 18px; display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 14px; align-content: start; border-radius: 9px; box-shadow: 0 15px 38px rgba(0,0,0,.42); }
.ma-pdf-page-preview { position: relative; aspect-ratio: 3 / 4; padding: 7px; overflow: hidden; border: 1px solid rgba(255,255,255,.14); border-radius: 7px; background: #f7f9fa; cursor: pointer; }
.ma-pdf-page-preview.selected { border-color: #00a884; box-shadow: 0 0 0 2px rgba(0,168,132,.24); }
.ma-pdf-page-preview .ma-preview-media { background: #fff; }
.ma-pdf-page-preview span { position: absolute; right: 6px; bottom: 6px; min-width: 18px; height: 18px; display: grid; place-items: center; border-radius: 999px; background: #00a884; color: white; font-size: 9px; font-weight: 800; }
.ma-a4-item { position: absolute; inset: 6px; display: flex; align-items: center; justify-content: center; cursor: grab; touch-action: none; transform-origin: center; }
.ma-a4-item:active { cursor: grabbing; }
.ma-a4-item.selected::after { content: ''; position: absolute; inset: -3px; border: 2px solid #00a884; border-radius: 3px; pointer-events: none; }
.ma-preview-media { position: relative; width: 100%; height: 100%; overflow: hidden; }
.ma-preview-media img { position: absolute; max-width: none; max-height: none; object-fit: contain; transform-origin: center; }
.ma-a4-caption { color: #8696a0; font-size: 9px; }
.ma-merge-sidebar { display: grid; gap: 11px; }
.ma-layout-tabs { display: grid; grid-template-columns: repeat(4,1fr); gap: 5px; }
.ma-layout-tabs button { min-height: 46px; padding: 5px; border: 1px solid rgba(255,255,255,.1); border-radius: 7px; color: #aebbc1; background: #202c33; font-size: 9px; cursor: pointer; }
.ma-layout-tabs button.active { border-color: #00a884; color: white; background: rgba(0,168,132,.16); }
.ma-layout-tabs button:disabled { opacity: .38; cursor: not-allowed; }
.ma-merge-settings { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 11px; border: 1px solid rgba(255,255,255,.08); border-radius: 10px; background: #182329; }
.ma-merge-settings .wide { grid-column: 1 / -1; }
.ma-merge-settings input[type='color'] { padding: 4px; }
.ma-selected-controls { padding: 11px; display: grid; gap: 9px; border: 1px solid rgba(0,168,132,.22); border-radius: 10px; background: rgba(0,168,132,.07); }
.ma-selected-controls > strong { font-size: 11px; }
.ma-selected-controls > div { display: grid; grid-template-columns: repeat(3,1fr); gap: 5px; }
.ma-selected-controls button { min-height: 31px; padding: 0 6px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; border: 1px solid rgba(255,255,255,.1); border-radius: 6px; color: white; background: #202c33; font-size: 9px; cursor: pointer; }
.ma-selected-controls label { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 8px; color: #9fb0b8; font-size: 9px; }
.ma-selected-controls input[type='range'] { width: 100%; }
.ma-reset-position { width: 100%; }
.ma-workspace-bar { min-height: 44px; margin: 14px 0 10px; display: flex; align-items: center; gap: 10px; color: #8696a0; }
.ma-merge-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
.ma-merge-item { position: relative; overflow: hidden; border: 1px solid rgba(255,255,255,.09); border-radius: 9px; background: #182329; cursor: pointer; }
.ma-merge-item.selected { border-color: #00a884; box-shadow: 0 0 0 2px rgba(0,168,132,.12); }
.ma-drag-handle { position: absolute; top: 7px; left: 7px; z-index: 2; padding: 3px 5px; border-radius: 5px; background: rgba(17,27,33,.82); color: #aebbc1; font-size: 10px; cursor: grab; }
.ma-thumb-wrap { height: 128px; display: flex; align-items: center; justify-content: center; overflow: hidden; background: #0b1115; }
.ma-thumb { max-width: 100%; max-height: 100%; object-fit: contain; }
.ma-item-meta { padding: 8px 9px; display: flex; justify-content: space-between; gap: 8px; }
.ma-item-meta strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
.ma-item-meta span { flex: none; color: #8696a0; font-size: 9px; }
.ma-item-controls { padding: 0 7px 7px; display: flex; gap: 4px; }
.ma-item-controls button { width: 29px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 6px; background: #24343b; color: white; cursor: pointer; }
.ma-item-controls button:hover { background: #30454d; }
.ma-empty { padding: 30px; text-align: center; color: #8696a0; border: 1px dashed rgba(255,255,255,.14); border-radius: 10px; }
.ma-blob-crop { position: fixed; inset: 0; z-index: 10; padding: 70px; display: flex; align-items: center; justify-content: center; background: rgba(3,8,10,.92); }
.ma-blob-crop > img { max-width: 82vw; max-height: 76vh; object-fit: contain; }
.ma-toast-stack { position: fixed; right: 18px; bottom: 18px; z-index: 20; display: flex; flex-direction: column; gap: 7px; pointer-events: none; }
.ma-toast { width: min(360px, calc(100vw - 36px)); padding: 10px 12px; border: 1px solid rgba(255,255,255,.12); border-left: 3px solid #00a884; border-radius: 8px; background: #17242a; box-shadow: 0 10px 28px rgba(0,0,0,.4); }
.ma-toast.error { border-left-color: #ff777d; }
.ma-preset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(70px, 1fr)); gap: 6px; margin-bottom: 10px; }
.ma-preset-tile { min-height: 52px; padding: 6px 8px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; color: #cde0e8; background: #182329; cursor: pointer; transition: all .12s; }
.ma-preset-tile:hover { background: #1f2c33; border-color: #00a884; }
.ma-preset-tile.active { border-color: #00a884; background: rgba(0,168,132,.14); }
.ma-preset-tile:disabled { opacity: .45; cursor: wait; }
.ma-tile-label { font-size: 10px; font-weight: 700; color: inherit; }
.ma-tile-sub { font-size: 8.5px; color: #8696a0; font-weight: 500; }
.ma-compress-presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 6px; margin-bottom: 10px; }
.ma-size-btn { min-height: 34px; padding: 0 8px; border: 1px solid rgba(255,255,255,.12); border-radius: 7px; color: #cde0e8; background: #182329; font-size: 10px; font-weight: 700; cursor: pointer; transition: all .12s; }
.ma-size-btn:hover { background: #1f2c33; border-color: #00a884; }
.ma-size-btn.active { border-color: #00a884; background: rgba(0,168,132,.14); color: #00d6a3; }
.ma-size-btn:disabled { opacity: .45; cursor: wait; }
@media (max-width: 900px) { .ma-workspace-grid { grid-template-columns: 1fr; } .ma-merge-sidebar { grid-template-columns: 1fr 1fr; } .ma-selected-controls { grid-column: 1/-1; } .ma-toolbar { max-width: calc(100vw - 90px); } }
`;
