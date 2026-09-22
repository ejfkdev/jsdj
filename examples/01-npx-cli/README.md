# Example: the CLI via `npx` / `bunx`

No install step, no `package.json` of your own. `npx` fetches the package, runs its
`bin`, and exits.

## Setup

Start the bundled fixture site in one terminal and leave it running:

```bash
node ../fixture-site/serve.mjs
```

Then run these from this directory.

## The commands

```bash
# Default Markdown report.
npx jsdj http://127.0.0.1:18080/

# Same thing, canonical subcommand form.
npx jsdj scan http://127.0.0.1:18080/

# Bare URL list, one per line — the form to diff or pipe.
npx jsdj -f text http://127.0.0.1:18080/

# Structured JSON, for `jq` or a script.
npx jsdj -f json http://127.0.0.1:18080/
npx jsdj --json http://127.0.0.1:18080/ | jq '.summary'

# Version, help, and the plugin list.
npx jsdj version
npx jsdj --help
npx jsdj --list-plugins

# Custom headers and a User-Agent.
npx jsdj -H 'Referer: http://127.0.0.1:18080/' --ua 'my-agent/1.0' -f text http://127.0.0.1:18080/

# Debug output goes to stderr, so stdout stays pipeable.
npx jsdj --debug -f text http://127.0.0.1:18080/ 2>/dev/null

# A proxy (start one first; the flag is accepted regardless).
npx jsdj -x socks5://127.0.0.1:7890 -f text http://127.0.0.1:18080/

# Write a second copy of every artifact, without the site-name directory level.
npx jsdj -o ./out -f text http://127.0.0.1:18080/
ls -R out

# Run only the webpack plugin, then only the HTML one, and compare.
npx jsdj --only-plugins WebpackPlugin -f text http://127.0.0.1:18080/
npx jsdj --only-plugins HTMLScriptPlugin -f text http://127.0.0.1:18080/

# Cache: first run fills it, second run replays it instantly.
npx jsdj --cache-dir ./.cache -f text http://127.0.0.1:18080/
npx jsdj --cache-dir ./.cache -f text http://127.0.0.1:18080/   # no network

# Force a fresh scan even with a warm cache.
npx jsdj --cache-dir ./.cache --no-cache -f text http://127.0.0.1:18080/
```

`bunx` is a drop-in replacement:

```bash
bunx jsdj -f text http://127.0.0.1:18080/
```

## Exit codes

`0` on success, `1` for a usage or runtime error. Useful in a script:

```bash
if ! npx jsdj -f text "$URL" > urls.txt; then
  echo "scan failed" >&2
  exit 1
fi
wc -l < urls.txt
```

## What to expect

Against the fixture the CLI reports nine JS URLs:

```
http://127.0.0.1:18080/static/about.js
http://127.0.0.1:18080/static/changelog.js
http://127.0.0.1:18080/static/lazy.js
http://127.0.0.1:18080/static/releases.js
http://127.0.0.1:18080/static/runtime.js
http://127.0.0.1:18080/static/vendor.js
http://127.0.0.1:18080/static/10-ce0cc4f.js
http://127.0.0.1:18080/static/11-aa11bb2.js
http://127.0.0.1:18080/static/12-ff00ee1.js
```

Three come from the webpack chunk map in `runtime.js`, one from a dynamic `import()`,
four from the HTML and its pages, and one from `modulepreload`.