/**
 * Self-contained DOM accessibility walker script.
 *
 * This module exports a string containing a self-contained IIFE that, when
 * evaluated in a page context via `Runtime.evaluate`, returns a pruned
 * accessibility tree as JSON. It mirrors the logic in the content-script
 * `dom-operations.ts` walker but is serialisable for injection via CDP.
 *
 * Used by {@link RemoteAdapter} and the CLI when no content script is
 * available.
 */

/**
 * Returns a JavaScript source string that, when evaluated in a browser page
 * context, produces an {@link AccessibilityNode}-compatible JSON tree.
 */
export function getDomWalkerScript(): string {
  return DOM_WALKER_IIFE;
}

/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- inlined script */
const DOM_WALKER_IIFE = `(() => {
  const IMPLICIT_ROLE_MAP = {
    A: 'link', ARTICLE: 'article', ASIDE: 'complementary',
    BUTTON: 'button', DIALOG: 'dialog', FOOTER: 'contentinfo',
    FORM: 'form', H1: 'heading', H2: 'heading', H3: 'heading',
    H4: 'heading', H5: 'heading', H6: 'heading',
    HEADER: 'banner', HR: 'separator', IMG: 'img', INPUT: 'textbox',
    LI: 'listitem', MAIN: 'main', NAV: 'navigation', OL: 'list',
    OPTION: 'option', OUTPUT: 'status', PROGRESS: 'progressbar',
    SECTION: 'region', SELECT: 'combobox', TABLE: 'table',
    TD: 'cell', TEXTAREA: 'textbox', TH: 'columnheader',
    TR: 'row', UL: 'list',
  };

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);

  const INTERACTIVE_TAGS = new Set([
    'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY',
  ]);

  function getRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const t = el.type;
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'submit' || t === 'reset' || t === 'button') return 'button';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    return IMPLICIT_ROLE_MAP[tag] || 'generic';
  }

  function getDirectText(el) {
    let t = '';
    for (const c of el.childNodes) {
      if (c.nodeType === 3) t += c.textContent || '';
    }
    return t.trim();
  }

  function getAccessibleName(el) {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const ariaLabelledBy = el.getAttribute('aria-labelledby');
    if (ariaLabelledBy) {
      const parts = [];
      for (const id of ariaLabelledBy.split(/\\s+/)) {
        const ref = document.getElementById(id);
        if (ref) parts.push((ref.textContent || '').trim());
      }
      if (parts.length) return parts.join(' ');
    }
    const tag = el.tagName;
    if (tag === 'IMG') return el.alt || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (el.id) {
        const lbl = document.querySelector('label[for="' + el.id + '"]');
        if (lbl) return (lbl.textContent || '').trim();
      }
      return el.placeholder || '';
    }
    if (tag === 'A') return (el.textContent || '').trim();
    return getDirectText(el);
  }

  function getStates(el) {
    const s = [];
    if (el.getAttribute('aria-disabled') === 'true' || el.disabled) s.push('disabled');
    if (el.getAttribute('aria-expanded') === 'true') s.push('expanded');
    if (el.getAttribute('aria-expanded') === 'false') s.push('collapsed');
    if (el.getAttribute('aria-selected') === 'true') s.push('selected');
    if (el.getAttribute('aria-checked') === 'true' || el.checked) s.push('checked');
    if (el.getAttribute('aria-required') === 'true' || el.required) s.push('required');
    if (el.getAttribute('aria-readonly') === 'true' || el.readOnly) s.push('readonly');
    if (el.getAttribute('aria-hidden') === 'true') s.push('hidden');
    return s;
  }

  function getValue(el) {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? 'true' : 'false';
      return el.value || undefined;
    }
    if (el instanceof HTMLTextAreaElement) return el.value || undefined;
    if (el instanceof HTMLSelectElement) return el.value || undefined;
    if (el instanceof HTMLProgressElement) return String(el.value);
    const vn = el.getAttribute('aria-valuenow');
    if (vn !== null) return vn;
    return undefined;
  }

  function isVisible(el) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function isRelevant(el, role) {
    if (role !== 'generic') return true;
    if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) return true;
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    if (el.getAttribute('tabindex') !== null) return true;
    return false;
  }

  function buildSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const tag = el.tagName.toLowerCase();
    const al = el.getAttribute('aria-label');
    if (al) return tag + '[aria-label="' + CSS.escape(al) + '"]';
    const nm = el.getAttribute('name');
    if (nm) return tag + '[name="' + CSS.escape(nm) + '"]';
    const parts = [];
    let cur = el;
    while (cur && cur !== document.documentElement) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(sel);
      cur = parent;
    }
    return parts.join(' > ');
  }

  const nodeCount = { value: 0 };

  function walk(root, maxDepth, depth) {
    if (depth > maxDepth) return null;
    if (SKIP_TAGS.has(root.tagName)) return null;

    const role = getRole(root);
    const states = getStates(root);
    if (states.includes('hidden')) return null;

    // Check visibility but DON'T stop traversal — containers may be
    // zero-size while their children are visible (common in SPA frameworks).
    const visible = isVisible(root);

    const isRel = isRelevant(root, role);
    const isInteractive = INTERACTIVE_TAGS.has(root.tagName) || root.getAttribute('tabindex') !== null;
    const children = [];

    if (root.tagName === 'IFRAME') {
      try {
        const doc = root.contentDocument;
        if (doc && doc.body) {
          const c = walk(doc.body, maxDepth, depth + 1);
          if (c) children.push(c);
        }
      } catch (e) { /* cross-origin */ }
    } else {
      for (const child of root.children) {
        const c = walk(child, maxDepth, depth + 1);
        if (c) children.push(c);
      }
    }

    // Invisible element with no visible children — skip
    if (!visible && children.length === 0) return null;

    // Invisible or irrelevant container — promote children
    if (!visible || !isRel) {
      if (children.length === 0) return null;
      if (children.length === 1) return children[0];
      return { role: 'group', name: '', children };
    }

    nodeCount.value++;
    const node = { role, name: getAccessibleName(root) };
    const val = getValue(root);
    if (val !== undefined) node.value = val;

    if (isInteractive) node.selector = buildSelector(root);

    // Bounding box (page-absolute)
    const rect = root.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      node.boundingBox = {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      };
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= vw || rect.top >= vh) {
        node.offScreen = true;
      }
    }

    if (states.length > 0) node.states = states;
    if (children.length > 0) node.children = children;
    return node;
  }

  const root = document.body || document.documentElement;
  const tree = walk(root, 100, 0) || { role: 'document', name: document.title || '', children: [] };
  return { tree, nodeCount: nodeCount.value };
})()`;
