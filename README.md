# GitHub Sync for Textus

Keeps the folder open in Textus in step with a plain GitHub repository: the same paths, the same files, and **one commit per sync** — so github.com shows the folder as it is, and you can read it, search it and follow its history there.

It sits beside the official cloud-sync plugin instead of replacing it: that one carries WebDAV, Nutstore and S3, with encryption and content-addressed chunks; this one only speaks GitHub and writes real files — no chunks, no manifest.

## How it works

Plugins have no git, so this one talks to GitHub's [Git Database REST API](https://docs.github.com/en/rest/git): files go up as blobs → a new tree is laid over the branch's current tree → one commit points at it → the branch moves as the very last step. A sync that fails halfway leaves GitHub untouched; there is no half a commit.

To know what changed without downloading anything, the plugin computes each file's blob hash locally (`sha1("blob " + length + "\0" + content)`) and compares it three ways: this folder, GitHub's tree, and the hashes both sides agreed on at the last sync. Only files that changed travel, so a second sync is a handful of requests.

## What a sync does (this folder × GitHub)

| This folder | On GitHub | What happens |
| --- | --- | --- |
| unchanged | unchanged | nothing |
| added | missing | upload |
| changed | unchanged | upload |
| unchanged | added | download |
| unchanged | changed | download |
| unchanged | deleted | **brought back** (or deleted here too, if that is the setting) |
| changed | deleted | conflict |
| deleted | unchanged | deleted on GitHub, and this folder's copy goes to `.trash` |
| deleted | changed | conflict |
| added | added, same path, different content | conflict (first connection only) |

A few rules are deliberate:

- **Deletions only travel outward from this folder.** The plugin never empties the folder; a file deleted on GitHub comes back, unless the deletion was yours. Mirroring it the other way round is exactly how one sync once wiped a whole workspace.
- **Nothing disappears on the way.** A version a sync replaces or removes is first copied to `.trash/<time>/<path>`: this folder's `.trash` for the copy it drops here, the repository's `.trash` for the copy it drops there, both in the same commit. `.trash` itself never syncs, so a trash of a trash cannot happen; drag a file out of it to put it back.
- **A conflict is never guessed.** A file both sides changed waits for you (the panel asks per file); settings can also fix the answer to "keep mine", "take GitHub's" or "keep both".
- **Keep both** keeps GitHub's version in this folder's `.trash` and sends mine up, so neither side loses a byte. Whichever side a conflict answer leaves behind ends up in that side's `.trash`; the answer decides who wins, never who survives.
- **First connection**: when both the folder and the repository have content, the plugin asks which side wins (or "send only" / "receive only") before anything is overwritten; the side that loses keeps its copies in its `.trash`.

## What is in scope

Nothing is filtered by file type — Markdown, images, PDFs, `.html`, `.json` all sync. Only two things decide:

1. **Rules** in the plugin's settings, one per line, written like `.gitignore`: a path, a folder ending in `/`, the wildcards `*`/`?`/`[...]`, a leading `/` to pin a rule to the top of the folder, a leading `!` to put back something an earlier rule excluded. The default rules drop `node_modules/`, the usual build folders and the OS's own files.
2. **A size limit**, 20 MB by default and adjustable; the plugin's own hard limit is 32 MB a file (the plugin bridge accepts at most a 32 MB response) and GitHub's is 100 MB. Files over the limit stay here, and the panel lists which ones.

`.git`, `.textus` and `.trash` are never synced, whatever the rules say: the first would have the plugin reading its own commits, the second is the plugin's own data, and the third would let a trash's own copies travel back and forth.

## Setting it up

Everything is on the plugin's own page in Settings (Settings → Plugins → GitHub
Sync), so the token, the repository, the rules and the sync strategy are in one
place, before the first sync and without one.

1. Make a [fine-grained token](https://github.com/settings/tokens?type=beta) with **Contents: read and write** on the repository — or a classic token with `repo`.
2. Open that page: Settings → Plugins → GitHub Sync, or the GitHub tab in the sidebar and its "Open Settings" button.
3. Paste the token → pick or create a repository → pick a branch → save.
4. Back in the sidebar tab ("Open the sync tab"): if both sides have content, choose which one wins.

The token lives in Textus's secret storage, on this computer only, and never reaches the repository; disconnecting can delete it. The repository and the last sync's hashes are remembered in the folder's `.textus/plugins/luckylew23.github-sync/`.

## Automatic sync

- **Push after saving**: a few quiet seconds (5 by default, adjustable) after a save, then one commit for everything that changed meanwhile.
- **Pull on a timer**: every 5 minutes by default, and only while there is nothing to push and no unanswered conflict — otherwise it fights itself.
- **Sync now** in the sidebar follows the direction on the settings page (both ways, send only, receive only).

## Limits

- GitHub only. For Nutstore, WebDAV or S3 use the official cloud-sync plugin; this one keeps the same provider split, so those can be added later, but today it ships GitHub alone.
- One folder to one branch of one repository; merging across branches is out of scope, and history belongs on github.com.
- A repository large enough for GitHub to truncate the file listing (100 000 entries) makes the plugin stop with an error rather than sync a subset silently.
- Desktop platforms only (Windows, macOS, Linux): iOS has no writable folder to sync.

## Development

- `host.js` and `panel.js` are single files with no build step — a hard rule of the plugin catalog, which compares a release zip to the repository byte for byte. The panel pulls in `panel.css` and `panel.js` through `textus-resource:`.
- The pure parts — rule parsing, the three-way comparison, the conflict policies — are exported at the end of `host.js` and tested with Node: `node --test`.
- Releasing: `git tag v0.2.0 && git push origin v0.2.0`; the workflow zips the tag (`luckylew23.github-sync-0.2.0.zip`) and attaches it to the release.

## Licence

MIT