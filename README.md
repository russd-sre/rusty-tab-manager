# Rusty Tab Manager

A Chrome extension that keeps your tabs organised automatically.

## Features

- **Auto-grouping** — tabs are grouped by second-level domain as soon as they open. All `*.google.com` tabs go into a `google` group, all `*.github.com` tabs into a `github` group, and so on.
- **Auto-collapse** — clicking a tab in one group collapses all other groups, so only the active group is expanded at any time.
- **Sorted groups** — tab groups are kept in alphabetical order at all times.
- **Keyboard shortcut** — `Cmd+Shift+0` (Mac) / `Ctrl+Shift+0` (Windows/Linux) expands all groups at once.

## Installation (manual / development)

1. Clone this repository:
   ```bash
   git clone https://github.com/gitboy/rusty-tab-manager.git
   ```
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the cloned directory
5. The extension is now active — open a few tabs across different sites to see grouping in action

## Chrome Web Store

Coming soon.

## Permissions

| Permission | Reason |
|---|---|
| `tabs` | Read tab URLs to determine the domain for grouping |
| `tabGroups` | Create, update, and collapse tab groups |
| `storage` | Persist group state across browser sessions |

## Project structure

```
manifest.json       extension manifest (MV3)
background.js       service worker — handles tab events and grouping logic
popup.html          toolbar popup UI
popup.js            popup interaction logic
icons/              extension icons (16, 48, 128px)
```

## License

MIT
