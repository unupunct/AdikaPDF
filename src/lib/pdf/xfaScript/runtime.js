/* eslint-disable */
/**
 * Research prototype (no UI): a minimal XFA scripting object model for
 * running a form's JavaScript in a sandboxed engine (pdf.js' QuickJS sandbox
 * in the app, node:vm in the measurements). Plain ES2020 in sloppy mode
 * (scripts are run inside `with` so unqualified names resolve the XFA way).
 *
 * Covers: form nodes from model.ts (subform, field, exclGroup, draw…),
 * rawValue / formattedValue / isNull with typed values, presence / access /
 * mandatory and decorative property bags (border, font, caption…), implicit
 * SOM name resolution from the script's node, resolveNode(s) with a subset
 * of SOM (a.b[2].c, [*], $, $form, xfa.form, ..name, #class), instance
 * managers (_name, addInstance / removeInstance / setInstances / count),
 * script objects, xfa.host, xfa.form (recalculate, execValidate…),
 * xfa.layout (stubs), app (alert, viewerVersion…), util (printd, printf,
 * stream helpers), the Acrobat Doc as event.target with data objects
 * (attachments), event properties. FormCalc is not interpreted.
 *
 * Entry: xfaRun(model, opts) returns a JSON-able result.
 */
function xfaRun(MODEL, OPTS) {
  OPTS = OPTS || {};
  var G = (function () { return this; })() || globalThis;
  var result = { runs: 0, ok: 0, errors: [], messages: [], skippedFormCalc: 0, perEvent: {}, dataObjects: [], scriptKeys: {} };
  var currentEvent = null;
  var calculating = false;
  var uid = 0;

  // ---------- nodes ----------
  var PROPS = ['border', 'font', 'fill', 'color', 'edge', 'corner', 'ui', 'caption', 'assist', 'para', 'margin', 'value', 'validate', 'calculate', 'format',
    'bind', 'desc', 'extras', 'keep', 'occur', 'traversal', 'toolTip', 'speak', 'picture', 'message', 'oneOfChild', 'event', 'execute', 'variables', 'items', 'break', 'overflow'];

  function Node(def, parent) {
    this.id = ++uid;
    this.def = def;
    this.cls = def.cls;
    this.name = def.name;
    this.parent = parent;
    this.children = [];
    this.props = { presence: def.presence || 'visible', access: def.access || 'open' };
    this.vars = {};
    this.bags = {};
    this.raw = def.value == null ? null : typed(def, def.value);
    this.items = def.items ? def.items.slice() : null;
    this.saveItems = def.saveItems ? def.saveItems.slice() : null;
    this.proxy = null;
    // properties scripts read back: the null test, the kind of input, the tooltip
    if (def.cls === 'field' || def.cls === 'exclGroup') {
      this.bags.validate = bag({ nullTest: def.nullTest || 'disabled', scriptTest: 'error', formatTest: 'warning' });
      this.bags.ui = bag({ oneOfChild: bag({ className: def.ui || (def.cls === 'exclGroup' ? 'exclGroup' : 'textEdit') }) });
      this.bags.assist = bag({ toolTip: bag({ value: def.toolTip || '' }) });
    }
    if (def.dataVars) for (var i = 0; i < def.dataVars.length; i++) this.vars[def.dataVars[i].name] = { value: def.dataVars[i].value, className: 'text', name: def.dataVars[i].name };
  }

  function isNumeric(def) {
    return def.valueType === 'decimal' || def.valueType === 'integer' || def.valueType === 'float' || def.ui === 'numericEdit';
  }
  function typed(def, v) {
    if (v === null || v === undefined) return null;
    if (isNumeric(def) && def.ui !== 'checkButton') {
      if (v === '') return null;
      var n = Number(String(v).replace(',', '.'));
      return isNaN(n) ? String(v) : n;
    }
    if (def.ui === 'checkButton' && (def.valueType === 'integer' || def.valueType === 'decimal')) {
      var m = Number(v);
      return isNaN(m) ? String(v) : m;
    }
    return String(v);
  }

  function instantiate(def, parent) {
    var n = new Node(def, parent);
    for (var i = 0; i < def.children.length; i++) {
      var cd = def.children[i];
      var count = cd.occur ? Math.max(cd.occur.initial, cd.occur.min) : 1;
      for (var k = 0; k < count; k++) n.children.push(instantiate(cd, n));
    }
    // check buttons start off when they have no value
    if (def.ui === 'checkButton' && n.raw === null && def.items && def.items.length > 1) n.raw = typed(def, def.items[1]);
    return n;
  }

  /** Children visible by name: unnamed subforms / areas are transparent. */
  function namedChildren(n, name, out) {
    out = out || [];
    for (var i = 0; i < n.children.length; i++) {
      var c = n.children[i];
      if (c.name === name) out.push(c);
      else if ((!c.name || c.cls === 'area') && c.cls !== 'field' && c.cls !== 'draw') namedChildren(c, name, out);
    }
    return out;
  }
  function childByName(n, name) {
    var a = namedChildren(n, name);
    return a.length ? a[0] : null;
  }
  function sameNameSiblings(n) {
    if (!n.parent) return [n];
    var p = n.parent;
    // walk up through unnamed containers and areas for siblings like Acrobat does
    while ((!p.name || p.cls === 'area') && p.parent && p.cls !== 'form') p = p.parent;
    return namedChildren(p, n.name);
  }
  function indexOf(n) {
    var s = sameNameSiblings(n);
    for (var i = 0; i < s.length; i++) if (s[i] === n) return i;
    return 0;
  }
  function somOf(n) {
    var parts = [];
    for (var x = n; x; x = x.parent) {
      if (x.cls === 'form') { parts.unshift('form[0]'); break; }
      if (x.name) parts.unshift(x.name + '[' + indexOf(x) + ']');
      else parts.unshift('#' + x.cls + '[0]');
    }
    return 'xfa[0].' + parts.join('.');
  }
  function lookupVar(n, name) {
    for (var x = n; x; x = x.parent) if (Object.prototype.hasOwnProperty.call(x.vars, name)) return x.vars[name];
    return undefined;
  }

  /** Unqualified name from a node: itself, its children, then up the ancestors. */
  function implicit(n, name) {
    for (var x = n; x; x = x.parent) {
      if (x.name === name && x.cls !== 'form') return wrap(x);
      var c = childByName(x, name);
      if (c) return wrap(c);
      if (Object.prototype.hasOwnProperty.call(x.vars, name)) return x.vars[name];
      if (name.charAt(0) === '_' && name.length > 1) {
        var im = managerFor(x, name.slice(1));
        if (im) return im;
      }
    }
    return undefined;
  }

  // ---------- instance managers ----------
  function findDefOwner(n, name) {
    for (var i = 0; i < n.def.children.length; i++) if (n.def.children[i].name === name) return { owner: n, def: n.def.children[i] };
    for (var j = 0; j < n.children.length; j++) {
      var c = n.children[j];
      if (!c.name && c.cls !== 'field' && c.cls !== 'draw') {
        var r = findDefOwner(c, name);
        if (r) return r;
      }
    }
    return null;
  }
  var managers = {};
  function managerFor(n, name) {
    var f = findDefOwner(n, name);
    if (!f || (f.def.cls !== 'subform' && f.def.cls !== 'subformSet' && f.def.cls !== 'exclGroup')) return null;
    var key = f.owner.id + ':' + name;
    if (managers[key]) return managers[key];
    var owner = f.owner;
    var def = f.def;
    var list = function () { return owner.children.filter(function (c) { return c.def === def; }); };
    var occ = def.occur || { min: 1, max: 1, initial: 1 };
    var insertAt = function (pos) {
      var inst = instantiate(def, owner);
      var cur = list();
      var at;
      if (cur.length === 0) {
        // place by template order: after the last child whose def comes earlier
        var order = owner.def.children.indexOf(def);
        at = 0;
        for (var i = 0; i < owner.children.length; i++) if (owner.def.children.indexOf(owner.children[i].def) < order) at = i + 1;
      } else if (pos >= cur.length) at = owner.children.indexOf(cur[cur.length - 1]) + 1;
      else at = owner.children.indexOf(cur[pos]);
      owner.children.splice(at, 0, inst);
      fireTree(inst, 'initialize');
      return wrap(inst);
    };
    var im = {
      get count() { return list().length; },
      get min() { return occ.min; },
      get max() { return occ.max; },
      get name() { return '_' + name; },
      get className() { return 'instanceManager'; },
      addInstance: function () {
        if (occ.max >= 0 && list().length >= occ.max) throw new Error('XFA: max occurrences reached for ' + name);
        return insertAt(list().length);
      },
      insertInstance: function (pos) { return insertAt(pos); },
      removeInstance: function (i) {
        var cur = list();
        if (cur.length <= occ.min) throw new Error('XFA: min occurrences reached for ' + name);
        if (cur[i]) owner.children.splice(owner.children.indexOf(cur[i]), 1);
      },
      setInstances: function (k) {
        while (list().length < k) insertAt(list().length);
        while (list().length > k && list().length > 0) { var cur = list(); owner.children.splice(owner.children.indexOf(cur[cur.length - 1]), 1); }
      },
      moveInstance: function (from, to) {
        var cur = list();
        var a = cur[from];
        if (!a) return;
        owner.children.splice(owner.children.indexOf(a), 1);
        var rest = list();
        var at = to >= rest.length ? owner.children.indexOf(rest[rest.length - 1]) + 1 : owner.children.indexOf(rest[to]);
        owner.children.splice(at, 0, a);
      },
    };
    managers[key] = im;
    return im;
  }

  // ---------- SOM ----------
  function listOf(nodes, owner) {
    var arr = nodes.map(wrap);
    return {
      remove: function (x) { if (owner && x && x.__node) { var i = owner.children.indexOf(x.__node); if (i >= 0) owner.children.splice(i, 1); } },
      append: function () { throw new Error('XFA: nodes.append not supported'); },
      insert: function () { throw new Error('XFA: nodes.insert not supported'); },
      get length() { return arr.length; },
      item: function (i) { return arr[i]; },
      namedItem: function (nm) { for (var i = 0; i < arr.length; i++) if (arr[i].name === nm) return arr[i]; return null; },
      _arr: arr,
    };
  }
  function splitSom(expr) {
    var parts = [];
    var cur = '';
    var depth = 0;
    for (var i = 0; i < expr.length; i++) {
      var ch = expr.charAt(i);
      if (ch === '[') depth++;
      if (ch === ']') depth--;
      if (ch === '.' && depth === 0) {
        if (expr.charAt(i + 1) === '.') { parts.push(cur); cur = '..'; i++; continue; }
        parts.push(cur); cur = '';
        continue;
      }
      cur += ch;
    }
    parts.push(cur);
    return parts.filter(function (p) { return p !== ''; });
  }
  function descendantsNamed(n, name, out) {
    for (var i = 0; i < n.children.length; i++) {
      var c = n.children[i];
      if (c.name === name) out.push(c);
      descendantsNamed(c, name, out);
    }
    return out;
  }
  function resolveSom(from, expr, many) {
    expr = String(expr).replace(/\s+/g, '');
    var parts = splitSom(expr);
    var set = null;
    for (var p = 0; p < parts.length; p++) {
      var seg = parts[p];
      var m = /^(\.\.)?([^\[]*)(?:\[([^\]]*)\])?$/.exec(seg);
      if (!m) throw new Error('XFA SOM not supported: ' + expr);
      var deep = !!m[1];
      var name = m[2];
      var idx = m[3];
      var next = [];
      if (set === null) {
        if (name === 'xfa') { set = ['xfa']; continue; }
        if (name === '$' || name === 'this') next = [from];
        else if (name === '$form') next = [formRoot];
        else if (name === '$record' || name === '$data') { set = ['data']; continue; }
        else if (name === '$template' || name === '$layout' || name === '$host' || name === '$event') throw new Error('XFA SOM not supported: ' + name);
        else if (deep) next = descendantsNamed(from, name, []);
        else {
          for (var x = from; x; x = x.parent) {
            if (x.name === name && x.cls !== 'form') { next = sameNameSiblings(x); break; }
            var cs = namedChildren(x, name);
            if (cs.length) { next = cs; break; }
          }
        }
      } else if (set[0] === 'xfa') {
        if (name === 'form') { set = [formRoot]; continue; }
        if (name === 'datasets' || name === 'data' || name === 'record') { set = ['data']; continue; }
        throw new Error('XFA SOM not supported: xfa.' + name);
      } else if (set[0] === 'data') {
        return many ? listOf([]) : null; // data DOM not modelled
      } else {
        for (var s = 0; s < set.length; s++) {
          var base = set[s];
          if (name === 'parent') { if (base.parent) next.push(base.parent); continue; }
          if (name.charAt(0) === '#') { for (var c = 0; c < base.children.length; c++) if (base.children[c].cls === name.slice(1)) next.push(base.children[c]); continue; }
          if (deep) descendantsNamed(base, name, next);
          else namedChildren(base, name, next);
        }
      }
      if (idx === '*') set = next;
      else if (idx !== undefined && idx !== '') {
        var k = Number(idx);
        if (isNaN(k)) throw new Error('XFA SOM predicate not supported: ' + seg);
        set = next[k] ? [next[k]] : [];
      } else set = many ? next : next.slice(0, 1);
      if (!set.length) return many ? listOf([]) : null;
    }
    if (!set || set[0] === 'xfa') return many ? listOf([]) : xfaObj;
    if (set[0] === 'data') return many ? listOf([]) : null;
    return many ? listOf(set) : wrap(set[0]);
  }

  // ---------- property bags ----------
  function bag(store) {
    return new Proxy(store, {
      get: function (t, k) {
        if (typeof k === 'symbol') return t[k];
        if (k in t) return t[k];
        if (k === 'toString' || k === 'valueOf') return function () { return ''; };
        if (k === 'then') return undefined;
        t[k] = bag({});
        return t[k];
      },
      set: function (t, k, v) { t[k] = v; return true; },
    });
  }

  // ---------- node proxies ----------
  function choiceValue(n) {
    return n.raw;
  }
  function exclValue(n) {
    for (var i = 0; i < n.children.length; i++) {
      var c = n.children[i];
      if (c.def.ui === 'checkButton' && c.def.items && c.raw !== null && String(c.raw) === String(typed(c.def, c.def.items[0]))) return c.raw;
    }
    return null;
  }
  function setExcl(n, v) {
    for (var i = 0; i < n.children.length; i++) {
      var c = n.children[i];
      if (c.def.ui !== 'checkButton' || !c.def.items) continue;
      var on = typed(c.def, c.def.items[0]);
      c.raw = v !== null && String(v) === String(on) ? on : (c.def.items.length > 1 ? typed(c.def, c.def.items[1]) : null);
    }
  }

  var API = {
    rawValue: {
      get: function (n) { return n.cls === 'exclGroup' ? exclValue(n) : choiceValue(n); },
      set: function (n, v) {
        if (n.cls === 'exclGroup') setExcl(n, v);
        else n.raw = v === '' && isNumeric(n.def) ? null : typed(n.def, v);
      },
    },
    formattedValue: { get: function (n) { var v = API.rawValue.get(n); return v === null ? '' : String(v); }, set: function (n, v) { API.rawValue.set(n, v); } },
    editValue: {
      get: function (n) {
        var v = API.rawValue.get(n);
        if (v === null) return '';
        if (n.items && n.saveItems) { var i = n.saveItems.indexOf(String(v)); if (i >= 0) return n.items[i]; }
        return String(v);
      },
      set: function (n, v) {
        if (n.items && n.saveItems) { var i = n.items.indexOf(String(v)); if (i >= 0) { n.raw = typed(n.def, n.saveItems[i]); return; } }
        API.rawValue.set(n, v);
      },
    },
    isNull: { get: function (n) { var v = API.rawValue.get(n); return v === null || v === ''; } },
    name: { get: function (n) { return n.name; } },
    className: { get: function (n) { return n.cls; } },
    parent: { get: function (n) { return n.parent ? wrap(n.parent) : null; } },
    index: { get: function (n) { return indexOf(n); } },
    instanceIndex: { get: function (n) { return indexOf(n); } },
    somExpression: { get: function (n) { return somOf(n); } },
    all: { get: function (n) { return listOf(sameNameSiblings(n)); } },
    nodes: { get: function (n) { return listOf(n.children, n); } },
    instanceManager: { get: function (n) { return n.parent ? managerFor(n.parent, n.name) : null; } },
    presence: { get: function (n) { return n.props.presence; }, set: function (n, v) { n.props.presence = String(v); } },
    access: { get: function (n) { return n.props.access; }, set: function (n, v) { n.props.access = String(v); } },
    mandatory: {
      get: function (n) { return n.bags.validate ? String(n.bags.validate.nullTest) : 'disabled'; },
      set: function (n, v) { if (n.bags.validate) n.bags.validate.nullTest = String(v); },
    },
    length: { get: function (n) { return n.items ? n.items.length : 0; } },
    selectedIndex: {
      get: function (n) { if (!n.items) return -1; var s = n.saveItems || n.items; return s.indexOf(String(n.raw)); },
      set: function (n, i) { var s = n.saveItems || n.items; n.raw = s && s[i] !== undefined ? typed(n.def, s[i]) : null; },
    },
    isContainer: { get: function (n) { return true; } },
    locale: { get: function () { return 'ro_RO'; } },
    x: { get: function () { return '0mm'; } }, y: { get: function () { return '0mm'; } },
    w: { get: function () { return '10mm'; } }, h: { get: function () { return '10mm'; } },
  };
  var METHODS = {
    resolveNode: function (n, e) { return resolveSom(n, e, false); },
    resolveNodes: function (n, e) { return resolveSom(n, e, true); },
    execEvent: function (n, ev) { fireNode(n, String(ev)); },
    execCalculate: function (n) { fireTree(n, 'calculate'); },
    execValidate: function (n) { return validateTree(n); },
    execInitialize: function (n) { fireTree(n, 'initialize'); },
    clearItems: function (n) { n.items = []; n.saveItems = n.saveItems ? [] : null; },
    addItem: function (n, d, s) { (n.items = n.items || []).push(String(d)); if (s !== undefined) { n.saveItems = n.saveItems || n.items.slice(0, -1); n.saveItems.push(String(s)); } else if (n.saveItems) n.saveItems.push(String(d)); },
    deleteItem: function (n, i) { if (n.items) n.items.splice(i, 1); if (n.saveItems) n.saveItems.splice(i, 1); },
    setItems: function (n, s) { n.items = String(s).split(','); },
    getDisplayItem: function (n, i) { return n.items ? n.items[i] : null; },
    getSaveItem: function (n, i) { return n.saveItems ? n.saveItems[i] : n.items ? n.items[i] : null; },
    boundItem: function (n, d) { if (!n.items) return d; var i = n.items.indexOf(String(d)); return i >= 0 && n.saveItems ? n.saveItems[i] : d; },
    getItemState: function (n, i) { var s = n.saveItems || n.items || []; return String(s[i]) === String(n.raw); },
    setItemState: function (n, i, on) { var s = n.saveItems || n.items || []; if (on) n.raw = typed(n.def, s[i]); },
    isPropertySpecified: function () { return false; },
    getElement: function (n, k) { return n.bags[k] || (n.bags[k] = bag({})); },
    setElement: function () {},
    formatMessage: function (n, s) { return String(s); },
    clone: function () { throw new Error('XFA: clone not supported'); },
  };

  function wrap(n) {
    if (n.proxy) return n.proxy;
    n.proxy = new Proxy(n, {
      get: function (t, k) {
        if (typeof k === 'symbol') return undefined;
        if (k === '__node') return t;
        if (Object.prototype.hasOwnProperty.call(API, k)) return API[k].get(t);
        if (Object.prototype.hasOwnProperty.call(METHODS, k)) return function () { return METHODS[k].apply(null, [t].concat(Array.prototype.slice.call(arguments))); };
        if (k === 'toString') return function () { return somOf(t); };
        if (k === 'valueOf') return function () { return API.rawValue.get(t); };
        if (k.charAt(0) === '_' && k.length > 1) { var im = managerFor(t, k.slice(1)); if (im) return im; }
        if (k === 'variables') return t.vars;
        var c = childByName(t, k);
        if (c) return wrap(c);
        if (Object.prototype.hasOwnProperty.call(t.vars, k)) return t.vars[k];
        if (PROPS.indexOf(k) >= 0 || /Color$/.test(k)) return t.bags[k] || (t.bags[k] = bag({}));
        if (Object.prototype.hasOwnProperty.call(t.props, k)) return t.props[k];
        return undefined;
      },
      set: function (t, k, v) {
        if (Object.prototype.hasOwnProperty.call(API, k)) {
          if (!API[k].set) throw new Error('XFA: ' + k + ' is read-only');
          API[k].set(t, v);
          return true;
        }
        t.props[k] = v;
        return true;
      },
      has: function (t, k) { return typeof k === 'string' && (k in API || k in METHODS || !!childByName(t, k)); },
    });
    return n.proxy;
  }

  // ---------- host objects ----------
  var formTop = instantiate(MODEL.root, null);
  var formRoot = formTop;
  var dataObjects = [];
  function findDO(name) { for (var i = 0; i < dataObjects.length; i++) if (dataObjects[i].name === name) return dataObjects[i]; return null; }
  var doc = {
    get dataObjects() { return dataObjects.length ? dataObjects.map(function (d) { return { name: d.name, path: d.path, size: d.contents.length, MIMEType: 'application/octet-stream', creationDate: new Date(), modDate: new Date() }; }) : null; },
    createDataObject: function (a, b) {
      var name = typeof a === 'object' ? a.cName : a;
      var contents = typeof a === 'object' ? a.cValue : b;
      var old = findDO(name);
      if (old) dataObjects.splice(dataObjects.indexOf(old), 1);
      dataObjects.push({ name: String(name), path: String(name), contents: String(contents == null ? '' : contents) });
    },
    removeDataObject: function (name) { var d = findDO(name); if (d) dataObjects.splice(dataObjects.indexOf(d), 1); },
    getDataObject: function (name) { var d = findDO(name); return d ? { name: d.name, path: d.path, size: d.contents.length } : null; },
    getDataObjectContents: function (name) { var d = findDO(name); if (!d) throw new Error('No data object ' + name); return { __stream: d.contents }; },
    setDataObjectContents: function (name, stream) { var d = findDO(name); var c = stream && stream.__stream !== undefined ? stream.__stream : String(stream); if (d) d.contents = c; else doc.createDataObject(name, c); },
    importDataObject: function () { result.messages.push({ kind: 'importDataObject', text: 'file dialog (not simulated)' }); return false; },
    exportDataObject: function (o) { result.messages.push({ kind: 'exportDataObject', text: JSON.stringify(o) }); },
    resetForm: function () { result.messages.push({ kind: 'resetForm', text: '' }); },
    getField: function () { return null; },
    numPages: 1,
    path: '/form.pdf',
    documentFileName: 'form.pdf',
    info: {},
    viewState: {},
    calculateNow: function () { recalc(); },
    mailDoc: function () { result.messages.push({ kind: 'mailDoc', text: '' }); },
    print: function () {},
    saveAs: function () { throw new Error('saveAs not allowed'); },
  };
  var app = {
    viewerVersion: 2024.001, viewerType: 'Reader', viewerVariation: 'Reader', platform: 'WIN', language: 'ENU', formsVersion: 2024, plugIns: [],
    runtimeHighlight: true, runtimeHighlightColor: [], fs: {},
    alert: function (a) {
      var msg = typeof a === 'object' && a ? a.cMsg : a;
      var type = typeof a === 'object' && a ? a.nType : arguments[2];
      result.messages.push({ kind: 'alert', text: String(msg) });
      return type === 2 || type === 3 ? (OPTS.answerNo ? 3 : 4) : 1;
    },
    beep: function () {}, response: function () { return null; }, execDialog: function (desc) { return execDialog(desc); },
    popUpMenu: function () { return null; }, popUpMenuEx: function () { return null; }, launchURL: function (u) { result.messages.push({ kind: 'launchURL', text: String(u) }); },
    setTimeOut: function () { return {}; }, clearTimeOut: function () {}, setInterval: function () { return {}; }, clearInterval: function () {},
    thermometer: { begin: function () {}, end: function () {}, value: 0, text: '', duration: 100, cancelled: false },
    get activeDocs() { return [doc]; },
  };
  /** Acrobat dialogs (app.execDialog): load / store state, list picks from OPTS steps ('pick'). */
  var pendingPicks = [];
  function execDialog(desc) {
    var state = {};
    var dialog = {
      load: function (o) { for (var k in o) state[k] = o[k]; },
      store: function () { return state; },
      enable: function () {}, visible: function () {}, focus: function () {}, setForeColorRed: function () {},
      end: function () {},
    };
    result.messages.push({ kind: 'execDialog', text: '' });
    if (desc.initialize) desc.initialize.call(desc, dialog);
    var pick = pendingPicks.shift();
    if (pick === undefined) return 'cancel';
    var re = new RegExp(pick);
    for (var k in state) {
      var v = state[k];
      if (!v || typeof v !== 'object') continue;
      var hit = null;
      for (var item in v) if (re.test(item)) { hit = item; break; }
      if (!hit) continue;
      for (var item2 in v) v[item2] = item2 === hit ? 1 : -1;
      if (typeof desc[k] === 'function') desc[k].call(desc, dialog);
    }
    if (desc.commit) desc.commit.call(desc, dialog);
    return 'ok';
  }
  function pad(n, l) { n = String(n); while (n.length < l) n = '0' + n; return n; }
  var util = {
    printd: function (fmt, d) {
      if (!(d instanceof Date)) return '';
      if (typeof fmt === 'number') fmt = ['D:yyyymmddHHMMss', 'yyyy.mm.dd HH:MM:ss', 'yyyy/mm/dd HH:MM:ss'][fmt] || 'yyyy/mm/dd';
      return String(fmt).replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|HH|H|hh|h|MM|M|ss|s|tt/g, function (t) {
        switch (t) {
          case 'yyyy': return d.getFullYear();
          case 'yy': return pad(d.getFullYear() % 100, 2);
          case 'mm': return pad(d.getMonth() + 1, 2);
          case 'm': return d.getMonth() + 1;
          case 'dd': return pad(d.getDate(), 2);
          case 'd': return d.getDate();
          case 'HH': return pad(d.getHours(), 2);
          case 'H': return d.getHours();
          case 'MM': return pad(d.getMinutes(), 2);
          case 'M': return d.getMinutes();
          case 'ss': return pad(d.getSeconds(), 2);
          case 's': return d.getSeconds();
          default: return t;
        }
      });
    },
    printf: function (fmt) {
      var args = Array.prototype.slice.call(arguments, 1);
      var i = 0;
      return String(fmt).replace(/%([,0-9.]*)([dfsx])/g, function (all, mod, c) {
        var a = args[i++];
        if (c === 'd') return String(Math.trunc(Number(a)));
        if (c === 'f') { var m = /\.(\d+)/.exec(mod); return Number(a).toFixed(m ? Number(m[1]) : 6); }
        if (c === 'x') return Number(a).toString(16);
        return String(a);
      });
    },
    scand: function (fmt, s) { var d = new Date(String(s)); return isNaN(d.getTime()) ? null : d; },
    stringFromStream: function (s) { return s && s.__stream !== undefined ? s.__stream : String(s); },
    streamFromString: function (s) { return { __stream: String(s) }; },
    printx: function (fmt, s) { return String(s); },
  };
  var host = {
    name: 'Acrobat', appType: 'Reader', version: '11.0', language: 'ro_RO', platform: 'WIN', title: '', numPages: 1, currentPage: 0,
    validationsEnabled: true, calculationsEnabled: true,
    messageBox: function (msg, title, icon, buttons) {
      result.messages.push({ kind: 'messageBox', text: String(msg) });
      if (buttons === 2 || buttons === 3) return OPTS.answerNo ? 3 : 4;
      return 1;
    },
    setFocus: function () {}, resetData: function () { result.messages.push({ kind: 'resetData', text: '' }); }, print: function () {}, beep: function () {},
    openList: function () {}, gotoURL: function (u) { result.messages.push({ kind: 'gotoURL', text: String(u) }); }, response: function () { return null; },
    exportData: function () { result.messages.push({ kind: 'exportData', text: '' }); }, importData: function () {}, getFocus: function () { return null; },
  };
  var layout = {
    pageCount: function () { return 1; }, absPageCount: function () { return 1; }, page: function () { return 1; }, absPage: function () { return 0; },
    pageSpan: function () { return 1; }, relayout: function () {}, sheetCount: function () { return 1; }, h: function () { return 0; }, w: function () { return 0; }, x: function () { return 0; }, y: function () { return 0; },
    pageContent: function () { return listOf([]); }, ready: true,
  };
  var xfaForm = new Proxy({}, {
    get: function (t, k) {
      if (k === 'recalculate') return function () { recalc(); };
      if (k === 'execValidate') return function () { return validateTree(formRoot); };
      if (k === 'execCalculate') return function () { recalc(); };
      if (k === 'execInitialize') return function () { fireTree(formRoot, 'initialize'); };
      if (k === 'resolveNode') return function (e) { return resolveSom(formRoot, e, false); };
      if (k === 'resolveNodes') return function (e) { return resolveSom(formRoot, e, true); };
      if (k === 'remerge') return function () {};
      if (typeof k !== 'string') return undefined;
      var c = childByName(formRoot, k);
      return c ? wrap(c) : undefined;
    },
  });
  var xfaObj = {
    host: host, form: xfaForm, layout: layout, event: null,
    datasets: { data: bag({ saveXML: function () { return ''; } }), saveXML: function () { return ''; } },
    record: null, data: null,
    resolveNode: function (e) { return resolveSom(formRoot, e, false); },
    resolveNodes: function (e) { return resolveSom(formRoot, e, true); },
    signature: { enumerate: function () { return listOf([]); }, verify: function () { return 0; }, sign: function () { throw new Error('XFA signature.sign not supported'); }, clear: function () { return false; } },
  };
  var consoleObj = { println: function (s) { result.messages.push({ kind: 'console', text: String(s) }); }, show: function () {}, clear: function () {} };

  // ---------- running scripts ----------
  var exec = new Function('__scope', '__code', 'with (__scope) { return (function () { return eval(__code); }).call(this); }');
  var globalsCache = {};
  function isGlobal(k) {
    if (Object.prototype.hasOwnProperty.call(globalsCache, k)) return globalsCache[k];
    var r = false;
    try { r = typeof G[k] !== 'undefined'; } catch (e) { r = false; }
    globalsCache[k] = r;
    return r;
  }
  function scopeFor(n) {
    return new Proxy({}, {
      has: function (t, k) {
        if (typeof k !== 'string' || k === '__code' || k === '__scope') return false;
        if (k === 'xfa' || k === 'event' || k === 'app' || k === 'util' || k === 'console' || k === '$' || k === 'host') return true;
        if (isGlobal(k)) return false;
        if (Object.prototype.hasOwnProperty.call(METHODS, k)) return true;
        return implicit(n, k) !== undefined;
      },
      get: function (t, k) {
        if (k === Symbol.unscopables) return undefined;
        if (k === 'xfa') return xfaObj;
        if (k === 'event') return currentEvent;
        if (k === 'app') return app;
        if (k === 'util') return util;
        if (k === 'console') return consoleObj;
        if (k === '$') return wrap(n);
        if (k === 'host') return host;
        var found = implicit(n, k);
        if (found === undefined && Object.prototype.hasOwnProperty.call(METHODS, k)) return wrap(n)[k];
        return found;
      },
      set: function (t, k, v) {
        // assignment to an unqualified XFA node name: Acrobat sets its value
        var target = implicit(n, k);
        if (target && target.__node) API.rawValue.set(target.__node, v);
        return true;
      },
    });
  }
  function makeEvent(n, name, extra) {
    var e = { name: name, target: doc, newText: '', prevText: '', change: '', fullText: '', selStart: 0, selEnd: 0, commitKey: 0, modifier: false, shift: false, keyDown: false, reenter: false, soapFaultCode: '', cancelAction: false };
    var v = n && n.cls !== 'form' ? API.rawValue.get(n) : null;
    e.prevText = e.newText = e.fullText = v === null ? '' : String(v);
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }
  function key(n, s) { return somOf(n) + '#' + s.event + '#' + n.def.scripts.indexOf(s); }
  function run(n, s, ev) {
    var k = s.event;
    var pe = result.perEvent[k] || (result.perEvent[k] = { runs: 0, ok: 0, errors: 0, formcalc: 0 });
    if (s.lang !== 'js') {
      var fc = formCalc(n, s.code);
      if (fc === FC_UNSUPPORTED) { pe.formcalc++; result.skippedFormCalc++; return undefined; }
      result.runs++; result.ok++; pe.runs++; pe.ok++;
      result.formCalcRun = (result.formCalcRun || 0) + 1;
      return fc;
    }
    var prev = currentEvent;
    currentEvent = ev || makeEvent(n, k);
    xfaObj.event = currentEvent;
    result.runs++;
    pe.runs++;
    var id = key(n, s);
    result.scriptKeys[id] = result.scriptKeys[id] || 'ok';
    try {
      var r = exec.call(wrap(n), scopeFor(n), s.code);
      result.ok++;
      pe.ok++;
      return r;
    } catch (e) {
      pe.errors++;
      result.scriptKeys[id] = 'error';
      if (result.errors.length < 400) result.errors.push({ node: somOf(n), event: k, error: String(e && e.message || e), stack: OPTS.stacks && e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : undefined });
      return undefined;
    } finally {
      currentEvent = prev;
      xfaObj.event = prev;
    }
  }
  /**
   * FormCalc, the tiny subset ANAF forms use: comments, `$ = expr` /
   * `this = expr` / a bare expression, + - * / ( ), numbers, SOM references
   * (with [*]) and sum(). Anything else is reported as not supported.
   */
  var FC_UNSUPPORTED = { unsupported: true };
  function formCalc(n, code) {
    var src = code.replace(/\/\/[^\n]*/g, '').replace(/;[^\n]*/g, '').trim();
    if (!src) return undefined;
    var m = /^(\$|this)\s*=\s*([\s\S]+)$/.exec(src);
    var expr = m ? m[2] : src;
    var toks = expr.match(/\s*(\d+(?:\.\d+)?|[A-Za-z_$][\w$]*(?:\[[^\]]*\])?(?:\.[A-Za-z_$][\w$]*(?:\[[^\]]*\])?)*|[-+*/(),])/g);
    if (!toks || toks.join('').replace(/\s+/g, '') !== expr.replace(/\s+/g, '')) return FC_UNSUPPORTED;
    toks = toks.map(function (t) { return t.trim(); });
    var i = 0;
    function val(path) {
      var list = resolveSom(n, path, true);
      var sum = 0;
      for (var k = 0; k < list.length; k++) { var v = list.item(k).rawValue; sum += Number(v) || 0; }
      return sum;
    }
    function primary() {
      var t = toks[i++];
      if (t === '(') { var v = add(); i++; return v; }
      if (t === '-') return -primary();
      if (/^\d/.test(t)) return Number(t);
      if (t === 'sum' && toks[i] === '(') {
        i++;
        var total = 0;
        while (toks[i] !== ')') { total += add(); if (toks[i] === ',') i++; }
        i++;
        return total;
      }
      if (/^[A-Za-z_$]/.test(t)) return val(t);
      throw new Error('FormCalc: unexpected ' + t);
    }
    function mul() { var v = primary(); while (toks[i] === '*' || toks[i] === '/') { var o = toks[i++]; var r = primary(); v = o === '*' ? v * r : v / r; } return v; }
    function add() { var v = mul(); while (toks[i] === '+' || toks[i] === '-') { var o = toks[i++]; var r = mul(); v = o === '+' ? v + r : v - r; } return v; }
    try {
      var out = add();
      if (i !== toks.length) return FC_UNSUPPORTED;
      return out;
    } catch (e) {
      return FC_UNSUPPORTED;
    }
  }
  function each(n, fn) {
    fn(n);
    var kids = n.children.slice();
    for (var i = 0; i < kids.length; i++) each(kids[i], fn);
  }
  function fireNode(n, evName, extra) {
    var out;
    for (var i = 0; i < n.def.scripts.length; i++) {
      var s = n.def.scripts[i];
      if (s.event === evName) out = run(n, s, makeEvent(n, evName, extra));
    }
    return out;
  }
  function fireTree(n, evName) { each(n, function (x) { fireNode(x, evName); }); }
  function calcNode(n) {
    for (var i = 0; i < n.def.scripts.length; i++) {
      var s = n.def.scripts[i];
      if (s.event !== 'calculate') continue;
      var v = run(n, s);
      if (v !== undefined && (n.cls === 'field' || n.cls === 'exclGroup' || n.cls === 'draw')) {
        try { API.rawValue.set(n, v && v.__node ? API.rawValue.get(v.__node) : v); } catch (e) { /* ignore */ }
      }
    }
  }
  function recalc() {
    if (calculating) return;
    calculating = true;
    try { each(formRoot, calcNode); } finally { calculating = false; }
  }
  function validateTree(root) {
    var ok = true;
    each(root, function (n) {
      for (var i = 0; i < n.def.scripts.length; i++) {
        var s = n.def.scripts[i];
        if (s.event !== 'validate') continue;
        var r = run(n, s);
        if (r === false) { ok = false; result.messages.push({ kind: 'validationFailed', text: somOf(n) }); }
      }
      if (n.bags.validate && String(n.bags.validate.nullTest) === 'error' && n.cls === 'field' && API.isNull.get(n) && n.props.presence === 'visible') ok = false;
    });
    return ok;
  }

  // ---------- script objects ----------
  function scriptObject(n, so) {
    var names = {};
    var re = /(?:^|[\n;{}])\s*function\s+([A-Za-z_$][\w$]*)\s*\(/g;
    var m;
    while ((m = re.exec(so.code))) names[m[1]] = 'f';
    var reVar = /^(?:var|let|const)\s+([A-Za-z_$][\w$]*)/gm;
    while ((m = reVar.exec(so.code))) if (!names[m[1]]) names[m[1]] = 'v';
    var parts = [];
    for (var k in names) parts.push('get ' + k + '() { return typeof ' + k + ' === "undefined" ? undefined : ' + k + '; }, set ' + k + '(v) { ' + k + ' = v; }');
    var code = so.code + '\n;({' + parts.join(',\n') + '})';
    try {
      // vars of the script object must stay its own: run it in a fresh function scope
      var obj = exec.call(wrap(n), scopeFor(n), '(function(){ return eval(' + JSON.stringify(code) + '); })()');
      n.vars[so.name] = obj;
      result.scriptKeys[somOf(n) + '#scriptObject#' + so.name] = 'ok';
    } catch (e) {
      n.vars[so.name] = {};
      result.scriptKeys[somOf(n) + '#scriptObject#' + so.name] = 'error';
      result.errors.push({ node: somOf(n) + '.' + so.name, event: 'scriptObject', error: String(e && e.message || e) });
    }
  }

  // ---------- the session ----------
  var t0 = Date.now();
  each(formRoot, function (n) { if (n.def.scriptObjects) for (var i = 0; i < n.def.scriptObjects.length; i++) scriptObject(n, n.def.scriptObjects[i]); });
  fireTree(formRoot, 'initialize');
  recalc();
  validateTree(formRoot);
  each(formRoot, function (n) { for (var i = 0; i < n.def.scripts.length; i++) { var s = n.def.scripts[i]; if (s.event === 'ready' || s.event === 'docReady') run(n, s); } });

  // set values (path -> value), firing enter / change / exit like typing
  var fills = OPTS.fill || {};
  for (var p in fills) {
    var target = resolveSom(formRoot, p, false);
    if (!target || !target.__node) { result.errors.push({ node: p, event: 'fill', error: 'field not found' }); continue; }
    var tn = target.__node;
    fireNode(tn, 'enter');
    fireNode(tn, 'change', { change: String(fills[p]), newText: String(fills[p]) });
    API.rawValue.set(tn, fills[p]);
    fireNode(tn, 'exit');
    recalc();
  }

  if (OPTS.allEvents) {
    // every remaining interactive event once, in document order (measures what breaks)
    var interactive = ['enter', 'exit', 'change', 'mouseEnter', 'mouseExit', 'mouseUp', 'mouseDown', 'preOpen', 'full', 'preSave', 'postSave', 'prePrint', 'postPrint', 'preSubmit'];
    each(formRoot, function (n) {
      for (var i = 0; i < n.def.scripts.length; i++) {
        var s = n.def.scripts[i];
        if (interactive.indexOf(s.event) >= 0) run(n, s, makeEvent(n, s.event));
      }
    });
  }
  var steps = OPTS.steps || [];
  for (var si = 0; si < steps.length; si++) {
    var st = steps[si];
    if (st[0] === 'pick') { pendingPicks.push(st[1]); continue; }
    var tg = resolveSom(formRoot, st[1], false);
    if (!tg || !tg.__node) { result.errors.push({ node: st[1], event: st[0], error: 'not found' }); continue; }
    var nd = tg.__node;
    if (st[0] === 'fill') {
      fireNode(nd, 'enter');
      fireNode(nd, 'change', { change: String(st[2]), newText: String(st[2]) });
      API.rawValue.set(nd, st[2]);
      fireNode(nd, 'exit');
    } else if (st[0] === 'click') {
      fireNode(nd, 'enter');
      fireNode(nd, 'mouseDown');
      fireNode(nd, 'mouseUp');
      fireNode(nd, 'click');
    }
    recalc();
  }
  var clicks = OPTS.click || [];
  for (var c = 0; c < clicks.length; c++) {
    var b = resolveSom(formRoot, clicks[c], false);
    if (!b || !b.__node) { result.errors.push({ node: clicks[c], event: 'click', error: 'button not found' }); continue; }
    fireNode(b.__node, 'click');
    recalc();
  }
  if (OPTS.allClicks) {
    each(formRoot, function (n) {
      for (var i = 0; i < n.def.scripts.length; i++) if (n.def.scripts[i].event === 'click') { run(n, n.def.scripts[i]); }
    });
  }
  result.ms = Date.now() - t0;
  result.dataObjects = dataObjects.map(function (d) { var c = d.contents; try { if (/%3C/i.test(c.slice(0, 20))) c = decodeURI(c); } catch (e) {} return { name: d.name, contents: c }; });
  var values = {};
  each(formRoot, function (n) { if (n.cls === 'field' && n.raw !== null && n.raw !== '' && n.def.ui !== 'button') values[somOf(n)] = n.raw; });
  result.values = values;
  return result;
}
