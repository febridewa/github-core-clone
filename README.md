# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/febridewa/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/febridewa/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one dependency-free Node 22 process: smart HTTP git (protocol v0 and v2 — upload-pack, receive-pack, ls-refs), REST v3 (repos, branches, commits, contents, labels, issues, pulls), GraphQL v4 (queries, mutations, Relay global ids, cursor pagination, introspection) and MCP (modern `server/discover` era plus the legacy `initialize` handshake). Everything is in-memory and deterministic — no network, no database, no `git` binary at runtime.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, and polls `$MAKEFUN_ENV_URL/done` until the trial ends. For local development, `dev.ts` starts the same forge on a fixed port without the env lifecycle:

```sh
MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types dev.ts 18080
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=6etrfz79&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
