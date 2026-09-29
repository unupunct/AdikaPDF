/**
 * Collects the user-visible interface strings (JSX text, labels, tooltips,
 * placeholders, option lists, toasts, progress and error messages) from
 * the .ts / .tsx files under src, for the translation dictionaries in src/locales.
 * Usage: node scripts/i18n-extract.cjs [repo] [out.json]
 */
const fs = require('fs');
const path = require('path');

const ts = require('typescript');

function extractUiStrings(repo) {
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|mts)$/.test(f) && !/\.d\.ts$/.test(f)) files.push(p);
    }
  })(path.join(repo, 'src'));

  const ATTRS = new Set(['label', 'tip', 'title', 'placeholder', 'description', 'ariaLabel', 'aria-label', 'alt', 'content', 'hint', 'emptyText', 'confirmLabel', 'cancelLabel']);
  const PROPS = new Set(['label', 'tip', 'title', 'description', 'hint', 'message', 'placeholder', 'example', 'caption', 'name']);
  const CALLS = new Set(['toast', 'withBusy', 'progress', 'onProgress', 'confirm', 'alert', 'setStatus', 'report', 'fail', 'ExportError', 'Error', 'BatchSkip', 'DesktopOnlyError', 'askConfirm', 'prompt']);
  const out = new Map(); // text -> Set(file:line)
  const skipFile = /src[\/](main.tsx|lib[\/]pdf[\/]iconvLiteShim.ts)$/;

  function add(text, file, node, sf) {
    let t = text.replace(/\s+/g, ' ').trim();
    if (!t || !/\p{L}{2,}/u.test(t)) return;
    if (/^[a-z][\w-]*$/.test(t) && !/\s/.test(t) && t.length < 25 && /[-_]|[a-z][A-Z]/.test(t)) return; // ids like tool-editText
    if (/^(https?:|#|\.|\/|@\/|[a-z]+\/[a-z])/.test(t)) return;
    if (/^(flex|grid|h-|w-|text-|mt-|mb-|px-|py-|rounded|border|bg-|absolute|relative)/.test(t)) return; // classNames
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const k = `${path.relative(repo, file).replace(/\\/g, '/')}:${line + 1}`;
    if (!out.has(t)) out.set(t, new Set());
    out.get(t).add(k);
  }

  function templateToPattern(node) {
    // `Replaced ${n} occurrence${s}.` -> "Replaced {0} occurrence{1}."
    let s = node.head.text;
    node.templateSpans.forEach((sp, i) => {
      s += `{${i}}` + sp.literal.text;
    });
    return s;
  }

  function strOf(n) {
    if (!n) return null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n)) return templateToPattern(n);
    return null;
  }

  for (const file of files) {
    if (skipFile.test(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n) => {
      if (ts.isJsxText(n)) add(n.text, file, n, sf);
      else if (ts.isJsxAttribute(n) && ATTRS.has(n.name.getText(sf)) && n.initializer) {
        const init = n.initializer;
        const v = strOf(init) ?? (ts.isJsxExpression(init) ? strOf(init.expression) : null);
        if (v != null) add(v, file, n, sf);
        else if (ts.isJsxExpression(init) && init.expression && ts.isConditionalExpression(init.expression)) {
          for (const b of [init.expression.whenTrue, init.expression.whenFalse]) {
            const s = strOf(b);
            if (s != null) add(s, file, b, sf);
          }
        }
      } else if (ts.isJsxExpression(n) && n.expression) {
        const e = n.expression;
        const s = strOf(e);
        if (s != null && n.parent && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) add(s, file, e, sf);
        if (ts.isConditionalExpression(e) && n.parent && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
          const walkCond = (c) => {
            for (const b of [c.whenTrue, c.whenFalse]) {
              if (ts.isConditionalExpression(b)) walkCond(b);
              else {
                const s2 = strOf(b);
                if (s2 != null) add(s2, file, b, sf);
              }
            }
          };
          walkCond(e);
        }
      } else if (ts.isPropertyAssignment(n) && PROPS.has(n.name.getText(sf).replace(/['"]/g, ''))) {
        const s = strOf(n.initializer);
        if (s != null) add(s, file, n, sf);
      } else if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments && n.arguments.length) {
        const callee = n.expression.getText(sf);
        const last = callee.split('.').pop();
        if (CALLS.has(last)) {
          const a = n.arguments[0];
          const s = strOf(a);
          if (s != null) add(s, file, a, sf);
          // toast(cond ? 'a' : 'b')
          if (a && ts.isConditionalExpression(a)) for (const b of [a.whenTrue, a.whenFalse]) { const s2 = strOf(b); if (s2 != null) add(s2, file, b, sf); }
          // String concatenation 'a' + (x ? 'b' : '') + 'c'
          if (a && ts.isBinaryExpression(a)) {
            const parts = [];
            const flat = (x) => { if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) { flat(x.left); flat(x.right); } else parts.push(x); };
            flat(a);
            for (const p of parts) {
              const s3 = strOf(p) ?? (ts.isParenthesizedExpression(p) && ts.isConditionalExpression(p.expression) ? strOf(p.expression.whenTrue) : null);
              if (s3 != null) add(s3, file, p, sf);
            }
          }
        }
      } else if (ts.isVariableDeclaration(n) && n.initializer && /HINTS|LABELS|TITLES|NAMES|TIPS/.test(n.name.getText(sf))) {
        // const TOOL_HINTS = { select: '...', ... }
        const obj = n.initializer;
        if (ts.isObjectLiteralExpression(obj)) for (const p of obj.properties) if (ts.isPropertyAssignment(p)) { const s = strOf(p.initializer); if (s != null) add(s, file, p, sf); }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return [...out.entries()].map(([text, where]) => ({ text, where: [...where].slice(0, 3) })).sort((a, b) => a.where[0].localeCompare(b.where[0]));
}

module.exports = { extractUiStrings };

if (require.main === module) {
  const repo = process.argv[2] ?? process.cwd();
  const list = extractUiStrings(repo);
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(list, null, 1));
  console.log('strings:', list.length);
}
