# GitHub Sync for Textus

Two-way sync between the folder open in Textus and a GitHub repository.
Push on save, pull on a schedule, and resolve the rare conflict per file.

## How it works

Textus plugins run in a sandbox with no git, so the plugin speaks to
GitHub's [Git Database REST API](https://docs.github.com/en/rest/git) instead.
That keeps one sync one atomic commit: files are uploaded as blobs, a tree is
written on top of the current remote tree, one commit points at it, and the
branch ref moves once — a half-finished sync can never reach the remote.

To know what changed without downloading anything, the plugin computes each
file's blob SHA locally (`sha1("blob " + length + "\0" + content)`) and
three-way diffs it against the remote tree and the SHAs recorded after the
last sync:

| local vs base | remote vs base | outcome |
| --- | --- | --- |
| unchanged | changed | pull |
| changed | unchanged | push |
| changed | changed differently | conflict, resolved per file |

Only the changed files are transferred, so a large folder's second sync costs
a handful of requests.

## Setup

1. Create a [personal access token](https://github.com/settings/tokens) with
   the `repo` scope.
2. Open the GitHub Sync panel (Settings › Extensions, or the status-bar item).
3. Paste the token, pick or create a repository, choose a branch.
4. If both the folder and the repository hold content, choose which side wins.

The token is stored in Textus's secret storage and never leaves it. The
repository and settings live per folder in `.textus/plugins/`.

## Syncing

- **Auto-push**: every save arms a 5-second debounce; when it goes quiet the
  plugin pushes. Turn it off in the panel's Settings section.
- **Auto-pull**: every 5 minutes, only when nothing is waiting to be pushed.
- **Conflicts**: the panel lists each conflicted file with three choices —
  keep local, keep remote, or keep both (the remote copy lands beside the
  local one as `name (remote).ext`).

## What is synced

Everything in the open folder except: folders whose name starts with a dot
(`.textus`, `.git`, …), anything matched by the folder's `.gitignore`, and
files over 10 MB.

## Limitations

- GitHub only (Gitee/Gitea's API differs); no git history browsing — use
  github.com for that.
- One branch per folder; merges across branches are out of scope.
- A 10 MB cap per file keeps a stray video from dominating a sync.

## License

MIT
