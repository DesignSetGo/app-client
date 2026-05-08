# @designsetgo/app-client

Bridge client for [DesignSetGo Apps](https://www.npmjs.com/package/@designsetgo/app-client) — the typed `dsgo` namespace that apps running inside the DesignSetGo Apps WordPress runtime use to read site data, call AI prompts, and invoke abilities.

## Install

```bash
npm install @designsetgo/app-client
```

Or scaffold a complete app project that has it pre-wired:

```bash
npx designsetgo apps init my-app
```

## Usage

```ts
import { dsgo } from '@designsetgo/app-client';

// Who's viewing this app?
const user = await dsgo.user.current();

// What posts are on the site?
const posts = await dsgo.posts.list({ per_page: 10 });

// Per-app key/value storage scoped to this app + user.
await dsgo.storage.set('preferred-color', 'blue');

// Call the site's configured AI provider through the WP AI Client.
const reply = await dsgo.ai.prompt({ prompt: 'Summarize this post', context: { post_id: 42 } });
```

The full bridge surface — every method, every error code, every permission — is documented in the spec: [BRIDGE-API.md](https://github.com/DesignSetGo/dsgo-apps/blob/main/BRIDGE-API.md).

## Transports

The client auto-detects whether it's running inside an iframe-mode app or an inline-mode app and uses the appropriate transport (`postMessage` for cross-frame, direct dispatch for same-window). Apps don't need to know which mode they're running under — the wire format is identical.

## Versioning

Pre-1.0. The bridge **protocol** (`bridge_version: 1`) is frozen; this client's version tracks SDK ergonomics, types, and helper methods. A major bump here does not imply a wire-protocol break — see [BRIDGE-API.md](https://github.com/DesignSetGo/dsgo-apps/blob/main/BRIDGE-API.md) for the protocol contract.

## Development

This repository is a public mirror. The source of truth lives in the DesignSetGo Apps monorepo and is mirrored here on every change. File issues here for bridge-client bugs; other DesignSetGo Apps issues (plugin, runtime, CLI) live at the [main project repo](https://github.com/DesignSetGo/dsgo-apps).

```bash
npm install
npm test
npm run build
```

## License

GPL-2.0-or-later
