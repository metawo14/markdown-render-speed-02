![markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)
![rank](https://make.fun/badge/markdown-render-speed-02/metawo14/markdown-render-speed-02/rank.svg)
![reward](https://make.fun/badge/markdown-render-speed-02/metawo14/markdown-render-speed-02/reward.svg)

# markdown-render-speed-02

A fast, dependency-free drop-in replacement for [marked](https://github.com/markedjs/marked) 18.1.3: `parse.js` renders Markdown to exactly the same HTML as `marked.parse()` with default options (GFM on, breaks off), but faster. `main.ts` is the harness driver: it reads every case from `cases.json` and writes the rendered HTML array to `html.json`.

Entry for the make.fun competition: https://make.fun/bounty/markdown-render-speed-02

## Usage

```js
import { parse } from './parse.js';
parse('# Hello\n\nSome *emphasis* and `code`.');
```

## Files

- `parse.js` — dependency-free ES module, `parse(markdown)` returns the HTML string.
- `main.ts` — Node 22 driver (built-ins only): reads `$MAKEFUN_INPUT_DIR/cases.json`, writes `$MAKEFUN_OUTPUT_DIR/html.json`.

## License

MIT — see [LICENSE](LICENSE).
