# Hotstar Zoom to Fill

Tampermonkey script that removes the black bars on Hotstar videos by zooming the video to fill the screen, like YouTube's "zoom to fill". Includes an on-screen toggle button and keyboard shortcuts.

- Script: `hotstar-fill.user.js`
- Version: 1.0
- Status: tested and working on hotstar.com (2026-10-02)

## Install

1. Install the Tampermonkey browser extension.
2. Tampermonkey icon → **Create a new script**.
3. Delete the template, paste the contents of `hotstar-fill.user.js`, then press Cmd+S.
4. Reload Hotstar.

## Controls

| Action | Control |
|---|---|
| Toggle Fill on/off | `Z` key, or click the button (top-right) |
| Zoom in / out (Fill must be on) | `]` / `[`, or scroll the mouse wheel over the button |
| Zoom range | 100%–200%, steps of 5% |

- The button shows `Fill OFF` or `Fill ON · 100%`.
- It hides after 3 seconds and reappears on mouse move.
- It works in fullscreen.
- It only appears on pages that have a video.
- On/off state and zoom level are saved and remembered across sessions.

## How it works

| Piece | What it does |
|---|---|
| `object-fit: cover` on the `<video>` | Scales the picture to cover the whole player and crops whatever spills over. Removes bars caused by screen vs video shape mismatch. |
| `transform: scale(zoom)` | Extra manual zoom for bars that are baked into the video picture itself |
| `overflow: hidden` on the video's parent | Keeps the zoomed video inside the player |
| Class `tm-fill-on` on `<html>` | Turns all of the above on or off. Videos Hotstar creates later get it automatically. |
| Button placement | Moves the button into the fullscreen element when you go fullscreen, so it stays visible |
| `localStorage` keys `tmFillOn`, `tmFillZoom` | Remember your settings |

It changes only how the video is displayed. It never reads the video, so it works with Hotstar's DRM.

## Two kinds of black bars

| Bar type | Fix |
|---|---|
| Video shape doesn't match the screen (e.g. 16:9 or 2.39:1 video on a 16:10 laptop screen) | Automatic when Fill is on. Crops the left and right edges, and much more for very wide films. |
| Bars burned into the video frame | Press `]` until they're gone. |

Bars burned into the frame can't be detected automatically, because DRM blocks scripts from reading video pixels.

## Known side effects

- Hover-preview videos on the homepage are also cropped while Fill is on.
- Subtitles may be cut off at high zoom levels (not seen so far).

## Troubleshooting

| Problem | Check |
|---|---|
| Button doesn't appear | Tampermonkey is enabled and the script is on. The URL matches `*.hotstar.com` or `*.jiohotstar.com`. Reload the page. |
| Keys don't work | Click the video once so the page has focus. Keys are ignored while typing in a search box. |
| Fill does nothing after a Hotstar update | Hotstar may have changed its player. Right-click the video → Inspect → copy the outerHTML of the element 2–3 levels above `<video>` and adjust the CSS selectors. |

Don't share a HAR file for debugging. It contains your login session cookies.
