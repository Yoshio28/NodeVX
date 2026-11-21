'use strict';
/* NodeVX — espacio de trabajo por bloques con bloc de notas rápidas.
   Sin dependencias. Los datos se guardan vía /api/store (lanzador .exe)
   o, si se abre index.html directamente, en localStorage. */
(() => {
  // ====================================================================
  // Utilidades
  // ====================================================================
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const now = () => Date.now();

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  function htmlToText(html) {
    const t = document.createElement('template');
    t.innerHTML = String(html || '').replace(/<br\s*\/?>/gi, '\n');
    return t.content.textContent;
  }
  const textToHtml = (s) => esc(s).replace(/\n/g, '<br>');

  function fmtDate(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('es', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function download(name, content, type = 'text/plain') {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const safeFileName = (s) => (s || 'Sin título').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);

  // ---------- Sanitizador de HTML en línea ----------
  const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'CODE', 'A', 'BR', 'SPAN', 'MARK']);
  function cleanNode(node) {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 3) continue;
      if (ch.nodeType !== 1) { ch.remove(); continue; }
      cleanNode(ch);
      const tag = ch.tagName;
      if (tag === 'DIV' || tag === 'P' || tag === 'LI') {
        const frag = document.createDocumentFragment();
        if (ch.previousSibling) frag.append(document.createElement('br'));
        frag.append(...ch.childNodes);
        ch.replaceWith(frag);
        continue;
      }
      if (tag === 'FONT') {
        const span = document.createElement('span');
        if (ch.getAttribute('color')) span.style.color = ch.getAttribute('color');
        span.append(...ch.childNodes);
        ch.replaceWith(span);
        cleanNode(span.parentNode || span);
        continue;
      }
      if (!ALLOWED.has(tag)) { ch.replaceWith(...ch.childNodes); continue; }
      const color = ch.style ? ch.style.color : '';
      const bg = ch.style ? ch.style.backgroundColor : '';
      const bold = ch.style && /bold|[6-9]00/.test(ch.style.fontWeight);
      const italic = ch.style && ch.style.fontStyle === 'italic';
      for (const a of [...ch.attributes]) {
        if (tag === 'A' && a.name === 'href' && /^(https?:|mailto:|#)/i.test(a.value.trim())) continue;
        ch.removeAttribute(a.name);
      }
      if (tag !== 'BR') {
        if (color) ch.style.color = color;
        if (bg) ch.style.backgroundColor = bg;
      }
      if (tag === 'SPAN') {
        // Chromium a veces expresa negrita/cursiva como estilos de span
        if (bold || italic) {
          let inner = document.createDocumentFragment();
          inner.append(...ch.childNodes);
          if (bold) { const x = document.createElement('b'); x.append(inner); inner = x; }
          if (italic) { const x = document.createElement('i'); x.append(inner); inner = x; }
          ch.append(inner);
        }
        if (!color && !bg) { ch.replaceWith(...ch.childNodes); continue; }
      }
      if (tag !== 'BR' && !ch.textContent && !ch.querySelector('br')) ch.remove();
    }
  }
  function clean(html) {
    const t = document.createElement('template');
    t.innerHTML = html || '';
    cleanNode(t.content);
    let out = t.innerHTML;
    if (out === '<br>') out = '';
    return out.replace(/<br>$/, '');
  }

  // Markdown en línea → HTML (para pegar texto y convertir notas rápidas)
  function inlineMd(s) {
    let x = esc(s);
    x = x.replace(/`([^`]+)`/g, '<code>$1</code>');
    x = x.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    x = x.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
    x = x.replace(/~~([^~]+)~~/g, '<s>$1</s>');
    x = x.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
    x = x.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2">$2</a>');
    return x;
  }

  // Texto con sintaxis Markdown → lista de bloques
  function parseMarkdown(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let code = null;
    for (const raw of lines) {
      if (code) {
        if (/^\s*```/.test(raw)) { out.push(code); code = null; } else code.text += (code.text || code._started ? '\n' : '') + raw, code._started = true;
        continue;
      }
      const fence = raw.match(/^\s*```(\w*)/);
      if (fence) { code = newBlock('code', '', { lang: fence[1] || 'plain' }); continue; }
      const indentMatch = raw.match(/^(\s*)/)[1].replace(/\t/g, '  ');
      const indent = Math.min(6, Math.floor(indentMatch.length / 2));
      const line = raw.trim();
      if (!line) { if (out.length && out[out.length - 1].type !== 'paragraph' || out.length && out[out.length - 1].text) out.push(newBlock('paragraph', '')); continue; }
      let m;
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) out.push(newBlock('h' + m[1].length, inlineMd(m[2])));
      else if ((m = line.match(/^[-*+]\s+\[( |x|X)\]\s*(.*)$/))) out.push(newBlock('todo', inlineMd(m[2]), { checked: m[1] !== ' ', indent }));
      else if ((m = line.match(/^\[( |x|X)?\]\s*(.*)$/))) out.push(newBlock('todo', inlineMd(m[2]), { checked: !!m[1] && m[1] !== ' ', indent }));
      else if ((m = line.match(/^[-*+•]\s+(.*)$/))) out.push(newBlock('bullet', inlineMd(m[1]), { indent }));
      else if ((m = line.match(/^\d+[.)]\s+(.*)$/))) out.push(newBlock('number', inlineMd(m[1]), { indent }));
      else if ((m = line.match(/^>\s?(.*)$/))) out.push(newBlock('quote', inlineMd(m[1])));
      else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) out.push(newBlock('divider'));
      else out.push(newBlock('paragraph', inlineMd(line), { indent }));
    }
    if (code) out.push(code);
    for (const b of out) delete b._started;
    while (out.length && out[out.length - 1].type === 'paragraph' && !out[out.length - 1].text) out.pop();
    return out;
  }

  // ====================================================================
  // Almacenamiento
  // ====================================================================
  const Store = {
    mode: 'local',
    info: null,
    async init() {
      if (location.protocol === 'file:') return;
      try {
        const r = await fetch('api/info', { cache: 'no-store' });
        if (r.ok) { const j = await r.json(); if (j.app === 'NodeVX') { this.mode = 'server'; this.info = j; } }
      } catch { /* sin servidor: modo navegador */ }
    },
    async load(name) {
      if (this.mode === 'server') {
        const r = await fetch('api/store/' + name, { cache: 'no-store' });
        if (r.status === 404 || r.status === 204) return null;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }
      try { const s = localStorage.getItem('nodevx:' + name); return s ? JSON.parse(s) : null; } catch { return null; }
    },
    async save(name, data) {
      const body = JSON.stringify(data);
      if (this.mode === 'server') {
        const r = await fetch('api/store/' + name, { method: 'PUT', body, headers: { 'Content-Type': 'application/json' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return;
      }
      localStorage.setItem('nodevx:' + name, body);
    },
    beacon(name, data) {
      const body = JSON.stringify(data);
      if (this.mode === 'server') navigator.sendBeacon('api/store/' + name, new Blob([body], { type: 'application/json' }));
      else try { localStorage.setItem('nodevx:' + name, body); } catch { /* lleno */ }
    },
  };

  function makeSaver(name, getData, onStatus, delay) {
    let timer = null, dirty = false, saving = false;
    async function flush() {
      clearTimeout(timer); timer = null;
      if (!dirty || readOnly) return;
      if (saving) { timer = setTimeout(flush, 150); return; }
      dirty = false; saving = true;
      onStatus('saving');
      try { await Store.save(name, getData()); onStatus(dirty ? 'dirty' : 'saved'); }
      catch (e) { console.error(e); dirty = true; onStatus('error'); timer = setTimeout(flush, 3000); }
      finally { saving = false; }
    }
    return {
      touch() { dirty = true; onStatus('dirty'); clearTimeout(timer); timer = setTimeout(flush, delay); },
      flush,
      beacon() { if (dirty && !readOnly) { Store.beacon(name, getData()); dirty = false; } },
      get dirty() { return dirty; },
    };
  }

  // ====================================================================
  // Modelo
  // ====================================================================
  const TYPES = {
    paragraph: { label: 'Texto', icon: '¶', desc: 'Empieza a escribir con texto simple.', ph: "Escribe '/' para ver comandos…", kw: 'texto parrafo text plain' },
    h1: { label: 'Encabezado 1', icon: 'H1', desc: 'Título de sección grande.', ph: 'Encabezado 1', kw: 'h1 titulo heading encabezado' },
    h2: { label: 'Encabezado 2', icon: 'H2', desc: 'Título de sección mediano.', ph: 'Encabezado 2', kw: 'h2 subtitulo heading encabezado' },
    h3: { label: 'Encabezado 3', icon: 'H3', desc: 'Título de sección pequeño.', ph: 'Encabezado 3', kw: 'h3 heading encabezado' },
    bullet: { label: 'Lista con viñetas', icon: '•', desc: 'Una lista simple con viñetas.', ph: 'Lista', kw: 'lista viñetas bullet ul' },
    number: { label: 'Lista numerada', icon: '1.', desc: 'Una lista con numeración.', ph: 'Lista', kw: 'lista numerada number ol' },
    todo: { label: 'Lista de tareas', icon: '☑', desc: 'Lleva el control de tus tareas.', ph: 'Tarea pendiente', kw: 'tareas todo checkbox pendiente' },
    toggle: { label: 'Lista desplegable', icon: '▸', desc: 'Oculta y muestra contenido.', ph: 'Desplegable', kw: 'toggle desplegable plegable' },
    quote: { label: 'Cita', icon: '❝', desc: 'Captura una cita.', ph: 'Cita vacía', kw: 'cita quote' },
    callout: { label: 'Destacado', icon: '💡', desc: 'Haz que el texto destaque.', ph: 'Escribe algo…', kw: 'destacado callout aviso nota' },
    code: { label: 'Código', icon: '</>', desc: 'Captura un fragmento de código.', ph: '', kw: 'codigo code snippet' },
    divider: { label: 'Divisor', icon: '—', desc: 'Separa visualmente los bloques.', ph: '', kw: 'divisor separador linea divider hr' },
    page: { label: 'Página', icon: '📄', desc: 'Inserta una subpágina dentro de esta.', ph: '', kw: 'pagina page subpagina' },
    image: { label: 'Imagen', icon: '🖼️', desc: 'Sube o inserta con un enlace.', ph: '', kw: 'imagen image foto picture' },
  };
  const TEXT_TYPES = new Set(['paragraph', 'h1', 'h2', 'h3', 'bullet', 'number', 'todo', 'toggle', 'quote', 'callout', 'code']);
  const CONTINUE_TYPES = new Set(['bullet', 'number', 'todo', 'toggle']);
  const COLORS = [['', 'Predeterminado'], ['gray', 'Gris'], ['red', 'Rojo'], ['orange', 'Naranja'], ['yellow', 'Amarillo'], ['green', 'Verde'], ['blue', 'Azul'], ['purple', 'Morado'], ['pink', 'Rosa']];
  const LANGS = ['plain', 'javascript', 'typescript', 'python', 'html', 'css', 'json', 'bash', 'sql', 'go', 'java', 'c', 'cpp', 'csharp', 'php', 'rust', 'markdown', 'yaml'];
  const COVERS = [
    'linear-gradient(135deg, #f6d365 0%, #fda085 100%)', 'linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)',
    'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)', 'linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)',
    'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)', 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
    'linear-gradient(135deg, #30cfd0 0%, #330867 100%)', 'linear-gradient(135deg, #2f3437 0%, #6b7280 100%)',
    'linear-gradient(120deg, #e0c3fc 0%, #8ec5fc 100%)', 'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)',
    'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)', 'linear-gradient(135deg, #fdfbfb 0%, #ebedee 100%)',
  ];
  const EMOJIS = ('📄 📝 📒 📓 📔 📕 📗 📘 📙 📚 📖 🗒️ 🗓️ 📅 📌 📍 📎 🖇️ ✏️ 🖊️ ✅ ☑️ ✔️ ❌ ⭐ 🌟 ✨ 💡 🔥 ⚡ 🎯 🚀 🏁 🏆 🎉 🎨 🎵 🎬 📷 💻 🖥️ ⌨️ 📱 🔧 🛠️ ⚙️ 🔒 🔑 🧠 💭 💬 📣 🔔 📢 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 👋 👍 🙌 👀 🤔 😀 😎 🥳 😴 🌱 🌿 🌳 🌸 🌻 🌙 ☀️ 🌈 ☁️ ❄️ 🌊 🍎 🍕 ☕ 🍵 🏠 🏢 🏫 ✈️ 🚗 🌍 🗺️ 💼 💰 💳 📈 📉 📊 🧾 🗂️ 📁 📦 🧪 🔬 🧩 🎲 ♟️ 🐶 🐱 🦊 🐼 🦄 🐝').split(' ');

  function newBlock(type = 'paragraph', text = '', extra = {}) {
    const b = { id: uid(), type, text, indent: 0, ...extra };
    if (type === 'todo' && b.checked == null) b.checked = false;
    if (type === 'callout' && !b.icon) b.icon = '💡';
    if (type === 'code' && !b.lang) b.lang = 'plain';
    if (type === 'toggle' && b.body == null) b.body = '';
    return b;
  }

  function newPage(extra = {}) {
    const t = now();
    return { id: uid(), parentId: null, title: '', icon: '', cover: '', children: [], blocks: [newBlock()], favorite: false, trashed: false, expanded: false, full: false, small: false, font: 'default', createdAt: t, updatedAt: t, ...extra };
  }

  function defaultWorkspace() {
    const w = { version: 1, rootIds: [], pages: {}, lastPageId: null, settings: { name: 'Mi espacio', theme: 'system', sidebarWidth: 260, sidebarCollapsed: false, qnOpen: false } };
    const welcome = newPage({ title: 'Bienvenido a NodeVX', icon: '👋', cover: COVERS[8], expanded: true });
    const tasks = newPage({ title: 'Lista de tareas', icon: '✅', parentId: welcome.id });
    tasks.blocks = [
      newBlock('h3', 'Hoy'),
      newBlock('todo', 'Revisar el correo'),
      newBlock('todo', 'Preparar la reunión de las 10:00'),
      newBlock('todo', 'Organizar mis notas en NodeVX', { checked: true }),
      newBlock('h3', 'Esta semana'),
      newBlock('todo', 'Planificar el proyecto'),
      newBlock('paragraph', ''),
    ];
    welcome.children = [tasks.id];
    welcome.blocks = [
      newBlock('callout', 'Este es tu espacio de trabajo. Todo lo que escribas se guarda <b>automáticamente en tu equipo</b>.', { icon: '💡' }),
      newBlock('h2', 'Lo básico'),
      newBlock('todo', 'Escribe <code>/</code> en cualquier línea para elegir un tipo de bloque'),
      newBlock('todo', 'Usa atajos Markdown: <code>#</code>, <code>##</code>, <code>-</code>, <code>1.</code>, <code>[]</code>, <code>&gt;</code>, <code>"</code>, <code>```</code>, <code>---</code>'),
      newBlock('todo', 'Selecciona texto para darle <b>negrita</b>, <i>cursiva</i>, <span style="color: rgb(51, 126, 169);">color</span> o un enlace'),
      newBlock('todo', 'Arrastra cualquier bloque desde ⋮⋮ para reordenarlo, o haz clic para ver más opciones'),
      newBlock('todo', 'Pulsa <b>Tab</b> para sangrar y <b>Shift+Tab</b> para quitar la sangría'),
      newBlock('h2', 'Notas rápidas (borrador)'),
      newBlock('paragraph', 'El panel <b>⚡ Notas rápidas</b> (<code>Alt+N</code>) es un bloc de notas que se guarda localmente al instante. Puedes tener varios borradores y, cuando una idea madure, pulsar <b>Convertir en página</b>.'),
      newBlock('toggle', '¿Dónde se guardan mis datos?', { body: 'En la carpeta <code>%APPDATA%\\NodeVX</code> de tu equipo: <b>workspace.json</b> (páginas) y <b>drafts.json</b> (notas rápidas). Cada día se guarda una copia de seguridad en la subcarpeta <b>backups</b>.' }),
      newBlock('page', '', { pageId: tasks.id }),
      newBlock('quote', 'Las ideas pequeñas también merecen un lugar.'),
      newBlock('paragraph', ''),
    ];
    w.pages[welcome.id] = welcome;
    w.pages[tasks.id] = tasks;
    w.rootIds = [welcome.id];
    w.lastPageId = welcome.id;
    return w;
  }

  function migrate(w) {
    w.version = w.version || 1;
    w.rootIds = Array.isArray(w.rootIds) ? w.rootIds : [];
    w.pages = w.pages || {};
    w.settings = Object.assign({ name: 'Mi espacio', theme: 'system', sidebarWidth: 260, sidebarCollapsed: false, qnOpen: false }, w.settings || {});
    for (const p of Object.values(w.pages)) {
      p.children = (p.children || []).filter((id) => w.pages[id]);
      p.blocks = Array.isArray(p.blocks) ? p.blocks : [];
      for (const b of p.blocks) { b.id = b.id || uid(); b.indent = b.indent || 0; }
    }
    w.rootIds = w.rootIds.filter((id) => w.pages[id]);
    // páginas huérfanas → raíz
    for (const p of Object.values(w.pages)) {
      const parent = p.parentId && w.pages[p.parentId];
      if (!parent) { p.parentId = null; if (!w.rootIds.includes(p.id)) w.rootIds.push(p.id); }
      else if (!parent.children.includes(p.id)) parent.children.push(p.id);
    }
    return w;
  }

  function defaultDrafts() {
    const d = { id: uid(), text: '', createdAt: now(), updatedAt: now() };
    return { activeId: d.id, items: [d] };
  }

  // ====================================================================
  // Estado
  // ====================================================================
  let ws = null;
  let drafts = null;
  let currentId = null;
  let readOnly = false;

  const statusEl = () => $('#save-status');
  const wsSaver = makeSaver('workspace', () => ws, (s) => {
    const el = statusEl();
    el.textContent = { saving: 'Guardando…', saved: 'Guardado', dirty: '', error: '⚠ Error al guardar' }[s];
    el.style.color = s === 'error' ? 'var(--danger)' : '';
  }, 450);
  const draftSaver = makeSaver('drafts', () => drafts, (s) => {
    const el = $('#qn-status');
    el.textContent = { saving: 'Guardando…', saved: 'Guardado en tu equipo ✓', dirty: 'Escribiendo…', error: '⚠ Error al guardar' }[s];
    el.style.color = s === 'error' ? 'var(--danger)' : '';
  }, 300);

  const cur = () => ws.pages[currentId];
  const getPage = (id) => ws.pages[id];

  function touchPage(p = cur()) { if (p) p.updatedAt = now(); wsSaver.touch(); }

  function siblingsOf(p) { return p.parentId ? getPage(p.parentId).children : ws.rootIds; }
  function childrenOf(p) { return p.children.map(getPage).filter((c) => c && !c.trashed); }
  function ancestors(p) { const out = []; let x = p; while (x && x.parentId) { x = getPage(x.parentId); if (x) out.unshift(x); } return out; }
  function isTrashedDeep(p) { let x = p; while (x) { if (x.trashed) return true; x = x.parentId && getPage(x.parentId); } return false; }
  function isDescendant(id, ofId) { let x = getPage(id); while (x && x.parentId) { if (x.parentId === ofId) return true; x = getPage(x.parentId); } return false; }
  const pageTitle = (p) => (p && p.title) || 'Sin título';
  const pageIcon = (p) => (p && p.icon) || '📄';

  // ====================================================================
  // Operaciones de páginas
  // ====================================================================
  function createPage(parentId = null, extra = {}, { addLink = true, after = null } = {}) {
    const p = newPage({ parentId, ...extra });
    ws.pages[p.id] = p;
    const list = parentId ? getPage(parentId).children : ws.rootIds;
    const i = after ? list.indexOf(after) : -1;
    if (i >= 0) list.splice(i + 1, 0, p.id); else list.push(p.id);
    if (parentId) {
      const parent = getPage(parentId);
      parent.expanded = true;
      if (addLink) parent.blocks.push(newBlock('page', '', { pageId: p.id }));
    }
    touchPage(p);
    return p;
  }

  function trashPage(id) {
    const p = getPage(id);
    if (!p) return;
    p.trashed = true;
    p.trashedAt = now();
    touchPage(p);
    if (currentId === id || isDescendant(currentId, id)) {
      const target = (p.parentId && !isTrashedDeep(getPage(p.parentId)) && p.parentId) || firstVisiblePageId(id);
      if (target) go(target); else { const np = createPage(null); go(np.id); }
    }
    renderSidebar();
    if (currentId && currentId !== id) renderBlocks();
    toast(`“${pageTitle(p)}” se movió a la papelera`, 'Deshacer', () => { restorePage(id); go(id); });
  }

  function restorePage(id) {
    const p = getPage(id);
    if (!p) return;
    p.trashed = false;
    if (p.parentId && (!getPage(p.parentId) || isTrashedDeep(getPage(p.parentId)))) movePage(id, null);
    touchPage(p);
    renderSidebar();
    renderBlocks();
  }

  function deleteForever(id) {
    const p = getPage(id);
    if (!p) return;
    const ids = [];
    (function collect(x) { ids.push(x.id); x.children.forEach((c) => getPage(c) && collect(getPage(c))); })(p);
    const list = siblingsOf(p);
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    ids.forEach((x) => delete ws.pages[x]);
    wsSaver.touch();
  }

  function firstVisiblePageId(exclude) {
    return ws.rootIds.find((id) => id !== exclude && getPage(id) && !getPage(id).trashed) || null;
  }

  function movePage(id, newParentId, beforeId = null) {
    const p = getPage(id);
    if (!p || id === newParentId || (newParentId && isDescendant(newParentId, id))) return false;
    const oldParent = p.parentId && getPage(p.parentId);
    const oldList = siblingsOf(p);
    const i = oldList.indexOf(id);
    if (i >= 0) oldList.splice(i, 1);
    if (oldParent && oldParent.id !== newParentId) oldParent.blocks = oldParent.blocks.filter((b) => !(b.type === 'page' && b.pageId === id));
    p.parentId = newParentId;
    const list = newParentId ? getPage(newParentId).children : ws.rootIds;
    const j = beforeId ? list.indexOf(beforeId) : -1;
    if (j >= 0) list.splice(j, 0, id); else list.push(id);
    if (newParentId) {
      const np = getPage(newParentId);
      np.expanded = true;
      if ((!oldParent || oldParent.id !== newParentId) && !np.blocks.some((b) => b.type === 'page' && b.pageId === id)) np.blocks.push(newBlock('page', '', { pageId: id }));
    }
    touchPage(p);
    return true;
  }

  function duplicatePage(id) {
    const src = getPage(id);
    const map = {};
    const copyTree = (p, parentId) => {
      const c = clone(p);
      c.id = uid(); map[p.id] = c.id;
      c.parentId = parentId; c.createdAt = c.updatedAt = now(); c.favorite = false;
      ws.pages[c.id] = c;
      c.children = p.children.filter((k) => getPage(k)).map((k) => copyTree(getPage(k), c.id));
      return c.id;
    };
    const newId = copyTree(src, src.parentId);
    const copy = getPage(newId);
    copy.title = pageTitle(src) + ' (copia)';
    for (const pid of Object.values(map)) {
      for (const b of getPage(pid).blocks) { b.id = uid(); if (b.type === 'page' && map[b.pageId]) b.pageId = map[b.pageId]; }
    }
    const list = siblingsOf(src);
    list.splice(list.indexOf(id) + 1, 0, newId);
    if (src.parentId) {
      const parent = getPage(src.parentId);
      const bi = parent.blocks.findIndex((b) => b.type === 'page' && b.pageId === id);
      parent.blocks.splice(bi >= 0 ? bi + 1 : parent.blocks.length, 0, newBlock('page', '', { pageId: newId }));
    }
    touchPage(copy);
    renderSidebar();
    go(newId);
  }

  function toggleFavorite(id) {
    const p = getPage(id);
    p.favorite = !p.favorite;
    wsSaver.touch();
    renderSidebar();
    renderTopbar();
  }

  // ====================================================================
  // Navegación
  // ====================================================================
  function go(id) {
    if (location.hash !== '#/p/' + id) history.pushState(null, '', '#/p/' + id);
    route();
  }

  function route() {
    const m = location.hash.match(/^#\/p\/([\w-]+)$/);
    let id = m && m[1];
    if (!id || !getPage(id)) {
      id = (ws.lastPageId && getPage(ws.lastPageId) && !isTrashedDeep(getPage(ws.lastPageId)) && ws.lastPageId) || firstVisiblePageId();
      if (!id) id = createPage(null, { title: '' }).id;
      history.replaceState(null, '', '#/p/' + id);
    }
    closePop();
    closeModal();
    currentId = id;
    if (ws.lastPageId !== id) { ws.lastPageId = id; wsSaver.touch(); }
    // expandir ancestros en la barra lateral
    ancestors(getPage(id)).forEach((a) => (a.expanded = true));
    renderSidebar();
    renderTopbar();
    renderPage();
    $('#scroller').scrollTop = 0;
    document.title = `${pageTitle(cur())} — NodeVX`;
  }

  // ====================================================================
  // Barra lateral
  // ====================================================================
  function renderSidebar() {
    $('.ws-name').textContent = ws.settings.name || 'Mi espacio';
    $('.ws-badge').textContent = (ws.settings.name || 'N').trim().charAt(0).toUpperCase() || 'N';
    const tree = $('#page-tree');
    tree.innerHTML = '';
    const roots = ws.rootIds.map(getPage).filter((p) => p && !p.trashed);
    if (!roots.length) tree.append(h('div', { class: 'tree-empty', text: 'Aún no hay páginas' }));
    roots.forEach((p) => renderTreeNode(p, 0, tree, true));

    const favs = Object.values(ws.pages).filter((p) => p.favorite && !isTrashedDeep(p));
    const favList = $('#fav-list');
    favList.innerHTML = '';
    $('#fav-section').classList.toggle('hidden', !favs.length);
    favs.forEach((p) => renderTreeNode(p, 0, favList, false));
  }

  function renderTreeNode(p, depth, container, nested) {
    const kids = childrenOf(p);
    const row = h('div', { class: 'tree-row' + (p.id === currentId ? ' active' : ''), dataset: { id: p.id }, draggable: nested ? 'true' : null, style: `padding-left:${4 + depth * 14}px` },
      nested ? h('button', { class: 'tw' + (p.expanded ? ' open' : ''), dataset: { act: 'toggle' }, title: 'Expandir', text: '▶' }) : h('span', { class: 'tw' }),
      h('span', { class: 'ti', text: pageIcon(p) }),
      h('span', { class: 'tt', text: pageTitle(p) }),
      h('span', { class: 'ta' },
        h('button', { class: 'icon-btn sm', dataset: { act: 'menu' }, title: 'Eliminar, duplicar y más…', text: '⋯' }),
        h('button', { class: 'icon-btn sm', dataset: { act: 'add' }, title: 'Añadir una página dentro', text: '＋' })));
    container.append(row);
    if (nested && p.expanded) {
      if (kids.length) kids.forEach((k) => renderTreeNode(k, depth + 1, container, true));
      else container.append(h('div', { class: 'tree-empty', style: `padding-left:${28 + (depth + 1) * 14}px`, text: 'No hay páginas dentro' }));
    }
  }

  function updatePageLabels(p) {
    $$(`.tree-row[data-id="${p.id}"]`).forEach((r) => { $('.tt', r).textContent = pageTitle(p); $('.ti', r).textContent = pageIcon(p); });
    if (p.id === currentId) { renderBreadcrumbs(); document.title = `${pageTitle(p)} — NodeVX`; }
    else if (ancestors(cur()).includes(p)) renderBreadcrumbs();
    $$(`.page-link[data-page="${p.id}"]`).forEach((a) => { $('.pl-i', a).textContent = pageIcon(p); $('.pl-t', a).textContent = pageTitle(p); });
  }

  function setupSidebar() {
    const sb = $('#sidebar');
    sb.addEventListener('click', (e) => {
      const row = e.target.closest('.tree-row');
      if (!row) return;
      const id = row.dataset.id;
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'toggle') { const p = getPage(id); p.expanded = !p.expanded; wsSaver.touch(); renderSidebar(); return; }
      if (act === 'add') { const np = createPage(id); renderSidebar(); go(np.id); focusTitle(); return; }
      if (act === 'menu') { pageMenu(id, e.target.closest('button')); return; }
      go(id);
    });
    sb.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.tree-row');
      if (!row) return;
      e.preventDefault();
      pageMenu(row.dataset.id, { left: e.clientX, top: e.clientY, bottom: e.clientY, right: e.clientX });
    });

    // Arrastrar páginas en el árbol (y soltar bloques encima de una página)
    let dragPage = null;
    sb.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.tree-row');
      if (!row) return;
      dragPage = row.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/nodevx-page', dragPage);
    });
    const clearMarks = () => $$('.drop-into, .drop-before, .drop-after, .drop-target', sb).forEach((x) => x.classList.remove('drop-into', 'drop-before', 'drop-after', 'drop-target'));
    const zone = (row, e) => {
      const r = row.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      if (dragBlock) return 'into';
      return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into';
    };
    sb.addEventListener('dragover', (e) => {
      if (!dragPage && !dragBlock) return;
      const row = e.target.closest('#page-tree .tree-row');
      const title = e.target.closest('#pages-title');
      clearMarks();
      if (title && dragPage) { e.preventDefault(); title.classList.add('drop-target'); return; }
      if (!row || row.dataset.id === dragPage || (dragPage && isDescendant(row.dataset.id, dragPage))) return;
      if (dragBlock && row.dataset.id === currentId) return;
      e.preventDefault();
      const z = zone(row, e);
      row.classList.add(z === 'into' ? 'drop-into' : 'drop-' + z);
      row.style.boxShadow = z === 'before' ? 'inset 0 2px 0 var(--accent)' : z === 'after' ? 'inset 0 -2px 0 var(--accent)' : '';
    });
    sb.addEventListener('dragleave', (e) => { const row = e.target.closest('.tree-row'); if (row) row.style.boxShadow = ''; });
    sb.addEventListener('drop', (e) => {
      const row = e.target.closest('#page-tree .tree-row');
      const title = e.target.closest('#pages-title');
      $$('.tree-row', sb).forEach((r) => (r.style.boxShadow = ''));
      clearMarks();
      if (dragBlock && row) {
        e.preventDefault();
        moveBlockToPage(dragBlock, row.dataset.id);
        dragBlock = null;
        return;
      }
      if (!dragPage) return;
      e.preventDefault();
      if (title) movePage(dragPage, null);
      else if (row) {
        const target = getPage(row.dataset.id);
        const z = zone(row, e);
        if (z === 'into') movePage(dragPage, target.id);
        else {
          const list = siblingsOf(target);
          const idx = list.indexOf(target.id);
          const before = z === 'before' ? target.id : list[idx + 1] || null;
          movePage(dragPage, target.parentId, before === dragPage ? list[idx + 2] || null : before);
        }
      }
      dragPage = null;
      renderSidebar();
      renderTopbar();
      renderBlocks();
    });
    sb.addEventListener('dragend', () => { dragPage = null; clearMarks(); $$('.tree-row', sb).forEach((r) => (r.style.boxShadow = '')); });

    // Redimensionar
    const rz = $('#sb-resizer');
    rz.addEventListener('mousedown', (e) => {
      e.preventDefault();
      rz.classList.add('active');
      const move = (ev) => {
        const w = Math.max(200, Math.min(480, ev.clientX));
        document.documentElement.style.setProperty('--sbw', w + 'px');
        ws.settings.sidebarWidth = w;
      };
      const up = () => { rz.classList.remove('active'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); wsSaver.touch(); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    $('#btn-collapse').onclick = toggleSidebar;
    $('#btn-expand').onclick = toggleSidebar;
    $('#btn-search').onclick = openSearch;
    $('#btn-quick').onclick = () => toggleQuickNotes();
    $('#btn-quick2').onclick = () => toggleQuickNotes();
    $('#btn-settings').onclick = openSettings;
    $('#btn-trash').onclick = openTrash;
    $('#btn-newpage').onclick = () => { const p = createPage(null); go(p.id); focusTitle(); };
    $('#btn-add-root').onclick = (e) => { e.stopPropagation(); const p = createPage(null); go(p.id); focusTitle(); };
  }

  function toggleSidebar() {
    ws.settings.sidebarCollapsed = !ws.settings.sidebarCollapsed;
    document.body.classList.toggle('sb-collapsed', ws.settings.sidebarCollapsed);
    wsSaver.touch();
  }

  function pageMenu(id, anchor) {
    const p = getPage(id);
    menu(anchor, [
      { icon: p.favorite ? '★' : '☆', label: p.favorite ? 'Quitar de favoritos' : 'Añadir a favoritos', action: () => toggleFavorite(id) },
      { icon: '⧉', label: 'Duplicar', action: () => duplicatePage(id) },
      { icon: '✎', label: 'Renombrar', action: () => { go(id); focusTitle(true); } },
      { icon: '＋', label: 'Añadir subpágina', action: () => { const np = createPage(id); renderSidebar(); go(np.id); focusTitle(); } },
      { icon: '⇩', label: 'Exportar como Markdown', action: () => exportMarkdown(id) },
      { sep: true },
      { icon: '🗑', label: 'Mover a la papelera', danger: true, action: () => trashPage(id) },
    ]);
  }

  // ====================================================================
  // Barra superior
  // ====================================================================
  function renderBreadcrumbs() {
    const bc = $('#breadcrumbs');
    bc.innerHTML = '';
    const chain = [...ancestors(cur()), cur()];
    chain.forEach((p, i) => {
      if (i) bc.append(h('span', { class: 'crumb-sep', text: '/' }));
      bc.append(h('button', { class: 'crumb', text: `${pageIcon(p)} ${pageTitle(p)}`, onclick: () => go(p.id) }));
    });
  }

  function renderTopbar() {
    renderBreadcrumbs();
    const fav = $('#btn-fav');
    fav.textContent = cur().favorite ? '★' : '☆';
    fav.classList.toggle('on', !!cur().favorite);
    fav.title = cur().favorite ? 'Quitar de favoritos' : 'Añadir a favoritos';
  }

  function setupTopbar() {
    $('#btn-fav').onclick = () => toggleFavorite(currentId);
    $('#btn-more').onclick = (e) => {
      const p = cur();
      const setFont = (f) => { p.font = f; touchPage(p); renderPage(); };
      menu(e.currentTarget, [
        { label: 'Estilo', heading: true },
        { icon: 'Aa', label: 'Predeterminada', check: p.font === 'default', action: () => setFont('default') },
        { icon: 'Ss', label: 'Serif', check: p.font === 'serif', action: () => setFont('serif') },
        { icon: 'Mm', label: 'Mono', check: p.font === 'mono', action: () => setFont('mono') },
        { sep: true },
        { icon: 'ᴀ', label: 'Texto pequeño', check: !!p.small, action: () => { p.small = !p.small; touchPage(p); renderPage(); } },
        { icon: '↔', label: 'Ancho completo', check: !!p.full, action: () => { p.full = !p.full; touchPage(p); renderPage(); } },
        { sep: true },
        { icon: '⧉', label: 'Duplicar', action: () => duplicatePage(p.id) },
        { icon: '⇩', label: 'Exportar como Markdown', action: () => exportMarkdown(p.id) },
        { icon: '⎙', label: 'Imprimir / Guardar PDF', action: () => setTimeout(() => window.print(), 50) },
        { sep: true },
        { icon: '🗑', label: 'Mover a la papelera', danger: true, action: () => trashPage(p.id) },
        { sep: true },
        { label: `Última edición: ${fmtDate(p.updatedAt)}`, heading: true },
        { label: `Creada: ${fmtDate(p.createdAt)}`, heading: true },
      ]);
    };
  }

  // ====================================================================
  // Página y editor
  // ====================================================================
  function focusTitle(selectAll = false) {
    requestAnimationFrame(() => {
      const t = $('#page .title');
      if (!t) return;
      t.focus();
      if (selectAll) { const r = document.createRange(); r.selectNodeContents(t); getSelection().removeAllRanges(); getSelection().addRange(r); }
      else setCaret(t, t.textContent.length);
    });
  }

  function renderPage() {
    const p = cur();
    const root = $('#page');
    root.innerHTML = '';
    if (p.cover) {
      const cover = h('div', { class: 'cover' },
        h('div', { class: 'cover-actions' },
          h('button', { dataset: { act: 'cover' }, text: 'Cambiar portada' }),
          h('button', { dataset: { act: 'cover-remove' }, text: 'Quitar' })));
      setCoverStyle(cover, p.cover);
      root.append(cover);
    }
    const wrap = h('div', { class: ['page-wrap', p.full && 'full', p.small && 'small', p.font !== 'default' && 'font-' + p.font, p.cover && 'has-cover'].filter(Boolean).join(' ') });
    const head = h('div', { class: 'page-head' },
      p.icon ? h('div', null, h('span', { class: 'page-icon', dataset: { act: 'icon' }, title: 'Cambiar icono', text: p.icon })) : null,
      h('div', { class: 'head-actions' },
        !p.icon && h('button', { dataset: { act: 'icon' }, text: '☺ Añadir icono' }),
        !p.cover && h('button', { dataset: { act: 'cover-add' }, text: '🖼 Añadir portada' })),
      h('div', { class: 'title', contenteditable: readOnly ? 'false' : 'true', spellcheck: 'true', 'data-placeholder': 'Sin título', text: p.title || '' }));
    wrap.append(head, h('div', { class: 'blocks' }), h('div', { class: 'add-below', dataset: { act: 'add-below' } }));
    root.append(wrap);
    renderBlocks();
  }

  function setCoverStyle(el, cover) {
    if (/^linear-gradient\(/.test(cover)) el.style.background = cover;
    else { el.style.backgroundImage = `url("${String(cover).replace(/["\\\n]/g, '')}")`; }
  }

  function renderBlocks(focus) {
    const p = cur();
    const container = $('#page .blocks');
    if (!p || !container) return;
    container.innerHTML = '';
    const counters = {};
    for (const b of p.blocks) {
      let n = 0;
      if (b.type === 'number') {
        counters[b.indent] = (counters[b.indent] || 0) + 1;
        for (const k of Object.keys(counters)) if (+k > b.indent) delete counters[k];
        n = counters[b.indent];
      } else for (const k of Object.keys(counters)) if (+k >= b.indent) delete counters[k];
      container.append(renderBlock(b, n));
    }
    if (focus) focusBlock(focus.id, focus.pos);
  }

  function blockClass(b) {
    const c = ['block', 't-' + b.type];
    if (b.color) c.push(b.color.startsWith('bg-') ? b.color : 'color-' + b.color);
    if (b.type === 'todo' && b.checked) c.push('done');
    if (b.type === 'toggle' && b.open) c.push('open');
    return c.join(' ');
  }

  function textEl(b, ph) {
    const editable = readOnly ? 'false' : b.type === 'code' ? 'plaintext-only' : 'true';
    const el = h('div', { class: 'text', contenteditable: editable, spellcheck: b.type === 'code' ? 'false' : 'true', 'data-placeholder': ph ?? TYPES[b.type]?.ph ?? '' });
    if (b.type === 'code') el.textContent = b.text || ''; else el.innerHTML = b.text || '';
    return el;
  }

  function renderBlock(b, n) {
    const el = h('div', { class: blockClass(b), dataset: { id: b.id }, style: `--indent:${b.indent || 0}` },
      h('div', { class: 'handle' },
        h('button', { class: 'add', dataset: { act: 'add' }, title: 'Clic para añadir un bloque debajo', text: '+' }),
        h('button', { class: 'drag', dataset: { act: 'drag' }, draggable: 'true', title: 'Arrastra para mover\nClic para abrir el menú', text: '⋮⋮' })));
    const body = h('div', { class: 'bbody' });
    el.append(body);
    switch (b.type) {
      case 'bullet': body.append(h('div', { class: 'prefix' }), textEl(b)); break;
      case 'number': body.append(h('div', { class: 'prefix', text: n + '.' }), textEl(b)); break;
      case 'todo': body.append(h('div', { class: 'prefix' }, h('input', { type: 'checkbox', checked: !!b.checked, dataset: { act: 'check' } })), textEl(b)); break;
      case 'toggle': {
        const col = h('div', { class: 'toggle-col' }, textEl(b));
        if (b.open) {
          const tb = h('div', { class: 'toggle-body', contenteditable: readOnly ? 'false' : 'true' });
          tb.innerHTML = b.body || '';
          col.append(tb);
        }
        body.append(h('div', { class: 'prefix' }, h('button', { dataset: { act: 'toggle' }, text: '▶' })), col);
        break;
      }
      case 'callout': body.append(h('span', { class: 'callout-icon', dataset: { act: 'callout-icon' }, text: b.icon || '💡' }), textEl(b)); break;
      case 'code': {
        const sel = h('select', { dataset: { act: 'lang' }, title: 'Lenguaje' }, LANGS.map((l) => h('option', { value: l, text: l === 'plain' ? 'Texto plano' : l, selected: b.lang === l })));
        body.append(sel, h('button', { class: 'copy-code', dataset: { act: 'copy-code' }, text: 'Copiar' }), textEl(b));
        break;
      }
      case 'divider': body.append(h('hr')); break;
      case 'page': {
        const tp = getPage(b.pageId);
        const gone = !tp;
        const trashed = tp && isTrashedDeep(tp);
        body.append(h('button', { class: 'page-link', dataset: { act: 'open-page', page: b.pageId || '' }, style: gone || trashed ? 'opacity:.5' : null },
          h('span', { class: 'pl-i', text: gone ? '🚫' : pageIcon(tp) }),
          h('span', { class: 'pl-t', text: gone ? 'Página eliminada' : pageTitle(tp) + (trashed ? ' (en la papelera)' : '') })));
        break;
      }
      case 'image': {
        if (b.src) {
          const img = h('img', { alt: htmlToText(b.text) || 'Imagen', loading: 'lazy' });
          img.src = b.src;
          body.append(img, Object.assign(textEl(b, 'Escribe un pie de foto…'), { className: 'text caption' }));
        } else {
          body.append(h('div', { class: 'img-empty' },
            h('span', { text: '🖼️' }),
            h('input', { type: 'url', placeholder: 'Pega la URL de una imagen y pulsa Enter…', dataset: { act: 'img-url' } }),
            h('button', { class: 'btn', dataset: { act: 'img-upload' }, text: 'Subir archivo' }),
            h('input', { type: 'file', accept: 'image/*', class: 'hidden', dataset: { act: 'img-file' } })));
        }
        break;
      }
      default: body.append(textEl(b));
    }
    return el;
  }

  // ---------- Búsqueda de bloques ----------
  function blockById(id, p = cur()) {
    const i = p.blocks.findIndex((b) => b.id === id);
    return i < 0 ? null : { b: p.blocks[i], i };
  }
  const blockElOf = (node) => node && node.closest && node.closest('.block');
  const blockOf = (node) => { const el = blockElOf(node); return el ? blockById(el.dataset.id) : null; };
  const textElOf = (id) => $(`#page .block[data-id="${id}"] .text`);

  // ---------- Cursor ----------
  function getCaret(el) {
    const sel = getSelection();
    if (!sel.rangeCount) return 0;
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer)) return 0;
    const pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length;
  }
  function rangeAt(el, offset) {
    const r = document.createRange();
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n, left = offset;
    while ((n = w.nextNode())) {
      if (left <= n.length) { r.setStart(n, left); r.collapse(true); return r; }
      left -= n.length;
    }
    r.selectNodeContents(el);
    r.collapse(false);
    return r;
  }
  function setCaret(el, offset) {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(rangeAt(el, Math.max(0, offset)));
  }
  function focusBlock(id, pos = 'end') {
    const el = textElOf(id);
    if (!el) {
      const blk = $(`#page .block[data-id="${id}"]`);
      const inp = blk && $('input[type="url"]', blk);
      if (inp) inp.focus();
      return;
    }
    el.focus();
    setCaret(el, pos === 'end' ? el.textContent.length : pos === 'start' ? 0 : pos);
  }
  function caretRect(el, offset) {
    const r = rangeAt(el, offset);
    const rects = r.getClientRects();
    const rect = rects.length ? rects[0] : r.getBoundingClientRect();
    return rect && (rect.top || rect.height) ? rect : el.getBoundingClientRect();
  }
  function onFirstLine(el) {
    const c = caretRect(el, getCaret(el)), s = caretRect(el, 0);
    return Math.abs(c.top - s.top) < 6;
  }
  function onLastLine(el) {
    const c = caretRect(el, getCaret(el)), e = caretRect(el, el.textContent.length);
    return Math.abs(c.top - e.top) < 6;
  }
  function selectionIsCollapsed() { const s = getSelection(); return !s.rangeCount || s.getRangeAt(0).collapsed; }

  function extractAfterCaret(el) {
    const sel = getSelection();
    const r = sel.getRangeAt(0);
    if (!r.collapsed) r.deleteContents();
    const after = document.createRange();
    after.setStart(r.startContainer, r.startOffset);
    after.setEnd(el, el.childNodes.length);
    const frag = after.extractContents();
    const d = document.createElement('div');
    d.append(frag);
    return el.dataset.plain ? d.textContent : clean(d.innerHTML);
  }

  function readText(el, b) { return b.type === 'code' ? el.textContent : clean(el.innerHTML); }

  function syncText(el) {
    const found = blockOf(el);
    if (!found) return;
    found.b.text = readText(el, found.b);
    touchPage();
  }

  // ---------- Operaciones de bloque ----------
  function insertAfter(index, block) { cur().blocks.splice(index + 1, 0, block); touchPage(); return block; }

  function setType(b, type) {
    if (b.type === 'code' && type !== 'code') b.text = textToHtml(b.text);
    else if (b.type !== 'code' && type === 'code') b.text = htmlToText(b.text);
    if (type === 'divider' || type === 'image' || type === 'page') b.text = '';
    b.type = type;
    if (type === 'todo' && b.checked == null) b.checked = false;
    if (type === 'callout' && !b.icon) b.icon = '💡';
    if (type === 'code' && !b.lang) b.lang = 'plain';
    if (type === 'toggle' && b.body == null) b.body = '';
    touchPage();
  }

  function turnInto(id, type) {
    const f = blockById(id);
    if (!f) return;
    if (type === 'page') {
      const np = createPage(currentId, { title: htmlToText(f.b.text).trim().slice(0, 200) }, { addLink: false });
      f.b.type = 'page'; f.b.pageId = np.id; f.b.text = '';
      renderSidebar();
      renderBlocks();
      return;
    }
    setType(f.b, type);
    if (type === 'divider' && !cur().blocks[f.i + 1]) insertAfter(f.i, newBlock());
    renderBlocks({ id: TEXT_TYPES.has(type) ? id : cur().blocks[f.i + 1]?.id || id, pos: 'end' });
  }

  function deleteBlock(id) {
    const f = blockById(id);
    if (!f) return;
    cur().blocks.splice(f.i, 1);
    if (f.b.type === 'page' && getPage(f.b.pageId) && !getPage(f.b.pageId).trashed && getPage(f.b.pageId).parentId === currentId) trashPage(f.b.pageId);
    if (!cur().blocks.length) cur().blocks.push(newBlock());
    touchPage();
    const prev = cur().blocks[Math.max(0, f.i - 1)];
    renderBlocks({ id: prev.id, pos: 'end' });
  }

  function duplicateBlock(id) {
    const f = blockById(id);
    if (!f) return;
    const c = { ...clone(f.b), id: uid() };
    insertAfter(f.i, c);
    renderBlocks({ id: c.id, pos: 'end' });
  }

  function moveBlock(id, delta) {
    const f = blockById(id);
    const j = f.i + delta;
    const list = cur().blocks;
    if (j < 0 || j >= list.length) return;
    list.splice(f.i, 1);
    list.splice(j, 0, f.b);
    touchPage();
    const el = textElOf(id);
    const pos = el ? getCaret(el) : 'end';
    renderBlocks({ id, pos });
  }

  function moveBlockToPage(id, pageId) {
    const f = blockById(id);
    const target = getPage(pageId);
    if (!f || !target || pageId === currentId) return;
    cur().blocks.splice(f.i, 1);
    if (!cur().blocks.length) cur().blocks.push(newBlock());
    f.b.indent = 0;
    target.blocks.push(f.b);
    if (f.b.type === 'page' && getPage(f.b.pageId)?.parentId === currentId) movePage(f.b.pageId, pageId);
    touchPage(); touchPage(target);
    renderSidebar();
    renderBlocks();
    toast(`Bloque movido a “${pageTitle(target)}”`, 'Ir', () => go(pageId));
  }

  function setIndent(b, delta, i) {
    const prev = cur().blocks[i - 1];
    const max = prev ? Math.min(6, (prev.indent || 0) + 1) : 0;
    const v = Math.max(0, Math.min(max, (b.indent || 0) + delta));
    if (v === (b.indent || 0)) return false;
    b.indent = v;
    touchPage();
    return true;
  }

  function blockMenu(id, anchor) {
    const f = blockById(id);
    if (!f) return;
    const items = [
      { icon: '🗑', label: 'Eliminar', kbd: 'Supr', action: () => deleteBlock(id) },
      { icon: '⧉', label: 'Duplicar', kbd: 'Ctrl+D', action: () => duplicateBlock(id) },
      { icon: '↑', label: 'Mover arriba', kbd: 'Ctrl+Shift+↑', action: () => moveBlock(id, -1) },
      { icon: '↓', label: 'Mover abajo', kbd: 'Ctrl+Shift+↓', action: () => moveBlock(id, 1) },
      { sep: true },
      { label: 'Convertir en', heading: true },
      ...Object.entries(TYPES).filter(([t]) => t !== 'image').map(([t, m]) => ({ icon: m.icon, label: m.label, check: f.b.type === t, action: () => turnInto(id, t) })),
      { sep: true },
      { label: 'Color', heading: true },
      ...COLORS.map(([c, name]) => ({ html: `<span class="color-swatch color-${c || 'x'}">A</span>`, label: name, check: (f.b.color || '') === c, action: () => { f.b.color = c; touchPage(); renderBlocks(); } })),
      { label: 'Fondo', heading: true },
      ...COLORS.map(([c, name]) => ({ html: `<span class="color-swatch ${c ? 'bg-' + c : ''}">&nbsp;</span>`, label: c ? 'Fondo ' + name.toLowerCase() : 'Sin fondo', check: c ? f.b.color === 'bg-' + c : false, action: () => { f.b.color = c ? 'bg-' + c : ''; touchPage(); renderBlocks(); } })),
    ];
    menu(anchor, items);
  }

  // ---------- Atajos Markdown ----------
  const MD_SHORTCUTS = [
    [/^#$/, 'h1'], [/^##$/, 'h2'], [/^###$/, 'h3'],
    [/^[-*+]$/, 'bullet'], [/^1[.)]$/, 'number'],
    [/^\[\s?\]$/, 'todo'], [/^\[[xX]\]$/, 'todo-done'],
    [/^>$/, 'toggle'], [/^["“]$/, 'quote'], [/^!$/, 'callout'],
  ];

  function deleteLeading(el, n) {
    const r = document.createRange();
    const start = rangeAt(el, 0), end = rangeAt(el, n);
    r.setStart(start.startContainer, start.startOffset);
    r.setEnd(end.startContainer, end.startOffset);
    r.deleteContents();
  }

  function tryMarkdown(el, b, e) {
    if (b.type === 'code') return false;
    const caret = getCaret(el);
    const before = el.textContent.slice(0, caret);
    if (e.data === ' ' || e.data === ' ') {
      const token = before.slice(0, -1);
      for (const [re, type] of MD_SHORTCUTS) {
        if (re.test(token) && (b.type === 'paragraph' || (type !== b.type && /^h\d$|^paragraph$/.test(b.type)))) {
          deleteLeading(el, caret);
          b.text = clean(el.innerHTML);
          if (type === 'todo-done') { setType(b, 'todo'); b.checked = true; } else setType(b, type);
          renderBlocks({ id: b.id, pos: 'start' });
          return true;
        }
      }
    }
    if (e.data === '`' && before === '```' && b.type === 'paragraph') {
      deleteLeading(el, 3);
      b.text = clean(el.innerHTML);
      setType(b, 'code');
      renderBlocks({ id: b.id, pos: 'start' });
      return true;
    }
    if (e.data === '-' && el.textContent === '---' && b.type === 'paragraph') {
      const f = blockById(b.id);
      b.text = '';
      setType(b, 'divider');
      const nb = insertAfter(f.i, newBlock());
      renderBlocks({ id: nb.id, pos: 'start' });
      return true;
    }
    return false;
  }

  // ---------- Menú "/" ----------
  let slash = null; // { el, blockId, start }
  const SLASH_EXTRA = [{ key: 'date', label: 'Fecha de hoy', icon: '📅', desc: 'Inserta la fecha actual.', kw: 'fecha hoy date today' }];

  function slashItems(q) {
    const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const nq = norm(q.trim());
    const all = [...Object.entries(TYPES).map(([key, m]) => ({ key, ...m })), ...SLASH_EXTRA];
    return all.filter((it) => !nq || norm(it.label + ' ' + it.kw).includes(nq));
  }

  function openSlash(el, blockId, start) {
    slash = { el, blockId, start };
    updateSlash();
  }

  function updateSlash() {
    if (!slash) return;
    const { el, start } = slash;
    if (!document.body.contains(el)) return closeSlash();
    const t = el.textContent, c = getCaret(el);
    if (t[start] !== '/' || c <= start) return closeSlash();
    const q = t.slice(start + 1, c);
    if (q.length > 24 || /\s\s/.test(q)) return closeSlash();
    const items = slashItems(q);
    if (!items.length && /\s$/.test(q)) return closeSlash();
    const rect = caretRect(el, start);
    const state = slash;
    const list = items.map((it) => ({
      html: `<span class="mi-ic">${esc(it.icon)}</span>`,
      label: it.label,
      desc: it.desc,
      action: () => applySlash(it.key, q, state),
    }));
    if (!list.length) list.push({ label: 'Sin resultados', heading: true });
    menu({ left: rect.left, top: rect.top, bottom: rect.bottom, right: rect.left }, [{ label: 'Bloques básicos', heading: true }, ...list], { slash: true, keepFocus: true, onClose: () => { slash = null; } });
  }

  function closeSlash() { if (slash) { slash = null; closePop(); } }

  function applySlash(key, q, s) {
    slash = null;
    closePop();
    if (!s) return;
    const { el, blockId, start } = s;
    const f = blockById(blockId);
    if (!f) return;
    // borrar "/consulta"
    const a = rangeAt(el, start), z = rangeAt(el, start + 1 + q.length);
    const r = document.createRange();
    r.setStart(a.startContainer, a.startOffset);
    r.setEnd(z.startContainer, z.startOffset);
    r.deleteContents();
    f.b.text = readText(el, f.b);
    const empty = !el.textContent.trim();
    touchPage();

    if (key === 'date') {
      el.focus();
      setCaret(el, start);
      document.execCommand('insertText', false, new Date().toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
      syncText(el);
      return;
    }
    if (key === 'page') {
      const np = createPage(currentId, {}, { addLink: false });
      const link = newBlock('page', '', { pageId: np.id });
      if (empty) cur().blocks.splice(f.i, 1, link); else insertAfter(f.i, link);
      touchPage();
      renderSidebar();
      go(np.id);
      focusTitle();
      return;
    }
    let target = f.b;
    if (!empty && !(key === 'divider')) {
      target = insertAfter(f.i, newBlock(key === 'image' ? 'image' : key, '', { indent: f.b.indent, src: '' }));
      if (key !== 'image') setType(target, key);
    } else if (key === 'divider') {
      const d = newBlock('divider');
      if (empty) cur().blocks.splice(f.i, 1, d); else insertAfter(f.i, d);
      const idx = cur().blocks.indexOf(d);
      const next = cur().blocks[idx + 1];
      const nb = next && TEXT_TYPES.has(next.type) && !next.text ? next : insertAfter(idx, newBlock());
      touchPage();
      renderBlocks({ id: nb.id, pos: 'start' });
      return;
    } else {
      setType(target, key);
    }
    if (key === 'image') { target.type = 'image'; target.src = ''; target.text = ''; }
    renderBlocks({ id: target.id, pos: 'end' });
  }

  // ---------- Pegar ----------
  function handlePaste(e, el, f) {
    const cd = e.clipboardData;
    const files = [...(cd.files || [])].filter((x) => x.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      files.forEach((file) => readImage(file, (src) => {
        const nb = insertAfter(blockById(f.b.id).i, newBlock('image', '', { src }));
        renderBlocks({ id: nb.id });
      }));
      return;
    }
    const text = cd.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    if (f.b.type === 'code') { document.execCommand('insertText', false, text); return; }
    if (!selectionIsCollapsed() && /^https?:\/\/\S+$/.test(text.trim())) { document.execCommand('createLink', false, text.trim()); syncText(el); return; }
    if (!text.includes('\n')) { document.execCommand('insertHTML', false, inlineMd(text)); syncText(el); return; }
    const blocks = parseMarkdown(text);
    if (!blocks.length) return;
    const after = extractAfterCaret(el);
    const first = blocks.shift();
    const wasEmpty = !el.textContent.trim();
    if (TEXT_TYPES.has(first.type) && first.type !== 'code') {
      el.insertAdjacentHTML('beforeend', first.text);
      f.b.text = readText(el, f.b);
      if (wasEmpty && f.b.type === 'paragraph') { setType(f.b, first.type); f.b.checked = first.checked; f.b.indent = first.indent || 0; }
    } else blocks.unshift(first);
    f.b.text = readText(el, f.b);
    let idx = blockById(f.b.id).i;
    for (const nb of blocks) { nb.indent = (nb.indent || 0) + (f.b.indent || 0); cur().blocks.splice(++idx, 0, nb); }
    let last = cur().blocks[idx];
    let pos = 'end';
    if (after) {
      if (TEXT_TYPES.has(last.type) && last.type !== 'code') { pos = htmlToText(last.text).length; last.text += after; }
      else { last = newBlock('paragraph', after); cur().blocks.splice(++idx, 0, last); pos = 0; }
    }
    touchPage();
    renderBlocks({ id: last.id, pos });
  }

  function readImage(file, cb) {
    if (file.size > 8 * 1024 * 1024) { toast('La imagen supera los 8 MB'); return; }
    const fr = new FileReader();
    fr.onload = () => cb(fr.result);
    fr.readAsDataURL(file);
  }

  // ---------- Teclado en bloques ----------
  function onBlockKeydown(e, el, f) {
    const { b, i } = f;
    const blocks = cur().blocks;
    const mod = e.ctrlKey || e.metaKey;
    const plain = b.type === 'code';

    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateBlock(b.id); return; }
    if (mod && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveBlock(b.id, e.key === 'ArrowUp' ? -1 : 1); return; }
    if (mod && e.altKey && /^[0-9]$/.test(e.key)) {
      const map = { 0: 'paragraph', 1: 'h1', 2: 'h2', 3: 'h3', 4: 'todo', 5: 'bullet', 6: 'number', 7: 'toggle', 8: 'code', 9: 'page' };
      e.preventDefault(); syncText(el); turnInto(b.id, map[e.key]); return;
    }
    if (mod && e.key === 'Enter' && b.type === 'todo') { e.preventDefault(); b.checked = !b.checked; touchPage(); renderBlocks({ id: b.id, pos: getCaret(el) }); return; }
    if (mod && e.key === 'Enter' && b.type === 'toggle') { e.preventDefault(); b.open = !b.open; touchPage(); renderBlocks({ id: b.id, pos: getCaret(el) }); return; }
    if (!plain && mod && !e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); formatCmd('code'); return; }
    if (!plain && mod && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); formatCmd('strikeThrough'); return; }
    if (!plain && mod && e.key.toLowerCase() === 'k' && !selectionIsCollapsed()) { e.preventDefault(); e.stopPropagation(); formatCmd('link'); return; }

    if (e.key === 'Enter' && !e.shiftKey) {
      if (plain) {
        if (mod) { e.preventDefault(); const nb = insertAfter(i, newBlock()); renderBlocks({ id: nb.id, pos: 'start' }); }
        return; // salto de línea normal en código
      }
      e.preventDefault();
      if (!el.textContent && (CONTINUE_TYPES.has(b.type) || b.type === 'quote' || b.type === 'callout')) {
        if (b.indent > 0 && CONTINUE_TYPES.has(b.type)) b.indent--; else setType(b, 'paragraph');
        touchPage();
        renderBlocks({ id: b.id, pos: 'start' });
        return;
      }
      const caret = getCaret(el);
      const nextType = CONTINUE_TYPES.has(b.type) ? b.type : 'paragraph';
      if (caret === 0 && el.textContent.length > 0 && selectionIsCollapsed()) {
        const nb = newBlock(TEXT_TYPES.has(b.type) && !/^h\d$/.test(b.type) ? nextType : 'paragraph', '', { indent: b.indent });
        blocks.splice(i, 0, nb);
        touchPage();
        renderBlocks({ id: b.id, pos: 'start' });
        return;
      }
      const after = extractAfterCaret(el);
      b.text = readText(el, b);
      const nb = insertAfter(i, newBlock(nextType, after, { indent: b.indent }));
      if (b.type === 'toggle' && b.open) { nb.type = 'paragraph'; nb.indent = b.indent + 1; }
      renderBlocks({ id: nb.id, pos: 'start' });
      return;
    }

    if (e.key === 'Backspace' && selectionIsCollapsed() && getCaret(el) === 0) {
      if (b.type !== 'paragraph' && TEXT_TYPES.has(b.type) && !(b.type === 'code' && el.textContent)) {
        e.preventDefault();
        setType(b, 'paragraph');
        renderBlocks({ id: b.id, pos: 'start' });
        return;
      }
      if (b.indent > 0) { e.preventDefault(); b.indent--; touchPage(); renderBlocks({ id: b.id, pos: 'start' }); return; }
      if (b.type === 'image') return;
      const prev = blocks[i - 1];
      if (!prev) {
        if (!el.textContent && blocks.length > 1) { e.preventDefault(); blocks.splice(i, 1); touchPage(); renderBlocks(); focusTitle(); }
        return;
      }
      e.preventDefault();
      if (!TEXT_TYPES.has(prev.type)) {
        if (!el.textContent) { blocks.splice(i, 1); touchPage(); renderBlocks(); const pel = $(`#page .block[data-id="${prev.id}"]`); pel && pel.classList.add('selected'); setTimeout(() => pel && pel.classList.remove('selected'), 600); }
        else if (prev.type === 'divider') { blocks.splice(i - 1, 1); touchPage(); renderBlocks({ id: b.id, pos: 'start' }); }
        return;
      }
      const offset = prev.type === 'code' ? prev.text.length : htmlToText(prev.text).length;
      if (prev.type === 'code') prev.text += el.textContent; else prev.text += readText(el, b);
      blocks.splice(i, 1);
      touchPage();
      renderBlocks({ id: prev.id, pos: offset });
      return;
    }

    if (e.key === 'Delete' && selectionIsCollapsed() && getCaret(el) === el.textContent.length) {
      const next = blocks[i + 1];
      if (!next) return;
      e.preventDefault();
      if (!TEXT_TYPES.has(next.type)) { if (next.type === 'divider') { blocks.splice(i + 1, 1); touchPage(); renderBlocks({ id: b.id, pos: 'end' }); } return; }
      const offset = el.textContent.length;
      b.text = readText(el, b) + (b.type === 'code' ? htmlToText(next.text) : next.type === 'code' ? textToHtml(next.text) : next.text);
      blocks.splice(i + 1, 1);
      touchPage();
      renderBlocks({ id: b.id, pos: offset });
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      if (plain) { document.execCommand('insertText', false, '  '); return; }
      const pos = getCaret(el);
      if (setIndent(b, e.shiftKey ? -1 : 1, i)) renderBlocks({ id: b.id, pos });
      return;
    }

    if (e.key === 'ArrowUp' && !e.shiftKey && selectionIsCollapsed() && onFirstLine(el)) {
      const prevEl = prevTextEl(el);
      e.preventDefault();
      if (prevEl) { prevEl.focus(); setCaret(prevEl, prevEl.textContent.length); } else focusTitle();
      return;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && selectionIsCollapsed() && onLastLine(el)) {
      const nextEl = nextTextEl(el);
      if (nextEl) { e.preventDefault(); nextEl.focus(); setCaret(nextEl, 0); }
      return;
    }
    if (e.key === 'ArrowLeft' && selectionIsCollapsed() && getCaret(el) === 0) {
      const prevEl = prevTextEl(el);
      if (prevEl) { e.preventDefault(); prevEl.focus(); setCaret(prevEl, prevEl.textContent.length); }
      return;
    }
    if (e.key === 'ArrowRight' && selectionIsCollapsed() && getCaret(el) === el.textContent.length) {
      const nextEl = nextTextEl(el);
      if (nextEl) { e.preventDefault(); nextEl.focus(); setCaret(nextEl, 0); }
      return;
    }
    if (e.key === 'Escape') { el.blur(); hideFormatBar(); }
  }

  const allTextEls = () => $$('#page .blocks .block > .bbody .text, #page .blocks .block > .bbody .toggle-col > .text');
  function prevTextEl(el) { const all = allTextEls(); return all[all.indexOf(el) - 1] || null; }
  function nextTextEl(el) { const all = allTextEls(); return all[all.indexOf(el) + 1] || null; }

  // ---------- Arrastrar bloques ----------
  let dragBlock = null;
  function setupBlockDrag(root) {
    root.addEventListener('dragstart', (e) => {
      const handle = e.target.closest && e.target.closest('[data-act="drag"]');
      if (!handle) return;
      const blk = blockElOf(handle);
      dragBlock = blk.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/nodevx-block', dragBlock);
      e.dataTransfer.setDragImage(blk, 20, 12);
      blk.style.opacity = '0.4';
      hideFormatBar();
    });
    const clear = () => $$('.drop-before, .drop-after', root).forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    const targetOf = (e) => {
      const blocks = $$('.blocks > .block', root);
      if (!blocks.length) return null;
      for (const el of blocks) {
        const r = el.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) return { el, where: 'before' };
      }
      return { el: blocks[blocks.length - 1], where: 'after' };
    };
    root.addEventListener('dragover', (e) => {
      if (!dragBlock) return;
      e.preventDefault();
      clear();
      const t = targetOf(e);
      if (t) t.el.classList.add('drop-' + t.where);
    });
    root.addEventListener('drop', (e) => {
      if (!dragBlock) return;
      e.preventDefault();
      clear();
      const t = targetOf(e);
      const f = blockById(dragBlock);
      if (!t || !f || t.el.dataset.id === dragBlock) { dragBlock = null; renderBlocks(); return; }
      const list = cur().blocks;
      list.splice(f.i, 1);
      let j = list.findIndex((b) => b.id === t.el.dataset.id);
      if (t.where === 'after') j++;
      list.splice(j, 0, f.b);
      const prev = list[j - 1];
      f.b.indent = Math.min(f.b.indent || 0, prev ? (prev.indent || 0) + 1 : 0);
      touchPage();
      dragBlock = null;
      renderBlocks();
    });
    root.addEventListener('dragend', () => { clear(); dragBlock = null; $$('.block', root).forEach((b) => (b.style.opacity = '')); });
  }

  // ---------- Eventos del editor ----------
  function setupEditor() {
    const root = $('#page');

    root.addEventListener('input', (e) => {
      const t = e.target;
      if (t.classList.contains('title')) {
        const p = cur();
        p.title = t.textContent.replace(/\n/g, ' ');
        touchPage(p);
        updatePageLabels(p);
        return;
      }
      if (t.classList.contains('toggle-body')) {
        const f = blockOf(t);
        if (f) { f.b.body = clean(t.innerHTML); touchPage(); }
        return;
      }
      if (!t.classList.contains('text')) return;
      const f = blockOf(t);
      if (!f) return;
      f.b.text = readText(t, f.b);
      touchPage();
      if (f.b.type === 'image') return;
      if (slash) { updateSlash(); return; }
      if (e.inputType === 'insertText' && tryMarkdown(t, f.b, e)) return;
      if (e.inputType === 'insertText' && e.data === '/' && f.b.type !== 'code') {
        const off = getCaret(t);
        const prevCh = t.textContent[off - 2];
        if (off === 1 || /\s/.test(prevCh || ' ')) openSlash(t, f.b.id, off - 1);
      }
    });

    root.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t.classList.contains('title')) {
        if (e.key === 'Enter' || (e.key === 'ArrowDown' && onLastLine(t))) {
          e.preventDefault();
          const p = cur();
          if (e.key === 'Enter' && getCaret(t) < t.textContent.length) {
            // dividir el título: el resto pasa al primer bloque
            const rest = t.textContent.slice(getCaret(t));
            t.textContent = t.textContent.slice(0, getCaret(t));
            p.title = t.textContent;
            p.blocks.unshift(newBlock('paragraph', esc(rest)));
            touchPage(p); updatePageLabels(p);
            renderBlocks({ id: p.blocks[0].id, pos: 'start' });
            return;
          }
          if (!p.blocks.length || (e.key === 'Enter' && p.blocks[0].text)) p.blocks.unshift(newBlock());
          touchPage(p);
          renderBlocks({ id: p.blocks[0].id, pos: 'start' });
        }
        return;
      }
      if (t.classList.contains('toggle-body')) { if (e.key === 'Escape') t.blur(); return; }
      if (t.dataset.act === 'img-url' && e.key === 'Enter') {
        e.preventDefault();
        const url = t.value.trim();
        const f = blockOf(t);
        if (f && /^(https?:|data:image\/)/i.test(url)) { f.b.src = url; touchPage(); const nb = cur().blocks[f.i + 1] || insertAfter(f.i, newBlock()); renderBlocks({ id: nb.id, pos: 'start' }); }
        else toast('Introduce una URL que empiece por http:// o https://');
        return;
      }
      if (!t.classList.contains('text')) return;
      const f = blockOf(t);
      if (f) onBlockKeydown(e, t, f);
    });

    root.addEventListener('paste', (e) => {
      const t = e.target.closest && (e.target.closest('.text') || e.target.closest('.title') || e.target.closest('.toggle-body'));
      if (!t) return;
      if (t.classList.contains('title') || t.classList.contains('toggle-body')) {
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, t.classList.contains('title') ? text.replace(/\s*\n\s*/g, ' ') : text);
        return;
      }
      const f = blockOf(t);
      if (f) handlePaste(e, t, f);
    });

    root.addEventListener('click', (e) => {
      const actEl = e.target.closest('[data-act]');
      const act = actEl && actEl.dataset.act;
      const a = e.target.closest('.text a');
      if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); return; }
      if (!act) return;
      const f = blockOf(actEl);
      switch (act) {
        case 'add': {
          const nb = newBlock('paragraph', '/', { indent: f.b.indent });
          insertAfter(f.i, nb);
          renderBlocks({ id: nb.id, pos: 'end' });
          openSlash(textElOf(nb.id), nb.id, 0);
          break;
        }
        case 'drag': blockMenu(f.b.id, actEl); break;
        case 'toggle': f.b.open = !f.b.open; touchPage(); renderBlocks(); if (f.b.open) { const tb = $(`#page .block[data-id="${f.b.id}"] .toggle-body`); tb && tb.focus(); } break;
        case 'open-page': if (actEl.dataset.page && getPage(actEl.dataset.page)) go(actEl.dataset.page); else toast('Esta página ya no existe'); break;
        case 'copy-code': copyText(f.b.text).then(() => toast('Código copiado')); break;
        case 'callout-icon': emojiPicker(actEl, (em) => { f.b.icon = em || '💡'; touchPage(); renderBlocks(); }); break;
        case 'img-upload': $('input[type="file"]', actEl.parentNode).click(); break;
        case 'icon': emojiPicker(actEl, (em) => { cur().icon = em; touchPage(); renderPage(); updatePageLabels(cur()); }, true); break;
        case 'cover-add': cur().cover = COVERS[Math.floor(Math.random() * COVERS.length)]; touchPage(); renderPage(); break;
        case 'cover': coverPicker(actEl); break;
        case 'cover-remove': cur().cover = ''; touchPage(); renderPage(); break;
        case 'add-below': {
          const blocks = cur().blocks;
          const last = blocks[blocks.length - 1];
          if (last && TEXT_TYPES.has(last.type) && last.type !== 'code' && !last.text) focusBlock(last.id, 'end');
          else { const nb = newBlock(); blocks.push(nb); touchPage(); renderBlocks({ id: nb.id }); }
          break;
        }
      }
    });

    root.addEventListener('change', (e) => {
      const t = e.target;
      const f = blockOf(t);
      if (!f) return;
      if (t.dataset.act === 'check') { f.b.checked = t.checked; touchPage(); blockElOf(t).classList.toggle('done', t.checked); }
      if (t.dataset.act === 'lang') { f.b.lang = t.value; touchPage(); }
      if (t.dataset.act === 'img-file' && t.files[0]) readImage(t.files[0], (src) => { f.b.src = src; touchPage(); renderBlocks(); });
    });

    root.addEventListener('focusout', (e) => {
      if (e.target.classList && e.target.classList.contains('title')) renderSidebar();
    });

    setupBlockDrag(root);
  }

  // ====================================================================
  // Barra de formato
  // ====================================================================
  function hideFormatBar() { $('#format-bar').classList.add('hidden'); }

  function updateFormatBar() {
    const bar = $('#format-bar');
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return hideFormatBar();
    const r = sel.getRangeAt(0);
    const node = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
    const host = node && (node.closest('#page .text') || node.closest('#page .toggle-body'));
    if (!host || host.getAttribute('contenteditable') === 'plaintext-only' || readOnly) return hideFormatBar();
    const rect = r.getBoundingClientRect();
    bar.classList.remove('hidden');
    const bw = bar.offsetWidth;
    bar.style.left = Math.max(8, Math.min(innerWidth - bw - 8, rect.left + rect.width / 2 - bw / 2)) + 'px';
    bar.style.top = Math.max(8, rect.top - bar.offsetHeight - 8) + 'px';
  }

  function formatCmd(cmd, value) {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    const node = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
    const host = node && (node.closest('.text') || node.closest('.toggle-body'));
    if (!host) return;
    document.execCommand('styleWithCSS', false, cmd === 'color' || cmd === 'hl');
    if (cmd === 'code') {
      const inCode = node.closest('code');
      if (inCode) inCode.replaceWith(...inCode.childNodes);
      else if (!r.collapsed) {
        const frag = r.extractContents();
        const code = document.createElement('code');
        code.textContent = frag.textContent;
        r.insertNode(code);
        sel.removeAllRanges();
        const nr = document.createRange(); nr.selectNodeContents(code); sel.addRange(nr);
      }
    } else if (cmd === 'link') {
      if (node.closest('a')) document.execCommand('unlink');
      else {
        const saved = r.cloneRange();
        const url = prompt('URL del enlace:', 'https://');
        if (url && /^(https?:|mailto:)/i.test(url.trim())) { sel.removeAllRanges(); sel.addRange(saved); document.execCommand('createLink', false, url.trim()); }
      }
    } else if (cmd === 'color') {
      if (value) document.execCommand('foreColor', false, value); else document.execCommand('removeFormat');
    } else if (cmd === 'hl') {
      document.execCommand('hiliteColor', false, value);
    } else document.execCommand(cmd);
    if (host.classList.contains('toggle-body')) { const f = blockOf(host); if (f) { f.b.body = clean(host.innerHTML); touchPage(); } }
    else syncText(host);
    updateFormatBar();
  }

  function setupFormatBar() {
    const bar = $('#format-bar');
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.cmd) formatCmd(btn.dataset.cmd);
      else if (btn.dataset.color != null) formatCmd('color', btn.dataset.color);
      else if (btn.dataset.hl) formatCmd('hl', 'rgba(255, 212, 0, 0.35)');
    });
    $('[data-color=""]', bar).title = 'Quitar formato';
    $('[data-color=""]', bar).textContent = '⨯';
    let raf = 0;
    document.addEventListener('selectionchange', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(updateFormatBar); });
    $('#scroller').addEventListener('scroll', () => { if (!$('#format-bar').classList.contains('hidden')) updateFormatBar(); });
  }

  // ====================================================================
  // Popovers y menús
  // ====================================================================
  let activePop = null;

  function closePop() {
    if (!activePop) return;
    const p = activePop;
    activePop = null;
    p.remove();
    if (p._onClose) p._onClose();
  }

  function placePop(pop, anchor) {
    const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
    pop.style.left = '0px'; pop.style.top = '0px'; pop.style.maxHeight = '';
    const pw = pop.offsetWidth;
    const below = innerHeight - r.bottom - 12, above = r.top - 12;
    const ph = Math.min(pop.scrollHeight, innerHeight * 0.6);
    let x = r.left, y;
    if (ph <= below || below >= above) { y = r.bottom + 4; pop.style.maxHeight = Math.min(ph, below) + 'px'; }
    else { const hgt = Math.min(ph, above); y = r.top - hgt - 4; pop.style.maxHeight = hgt + 'px'; }
    if (x + pw > innerWidth - 8) x = innerWidth - pw - 8;
    pop.style.left = Math.max(8, x) + 'px';
    pop.style.top = Math.max(8, y) + 'px';
  }

  function openPop(anchor, content, opts = {}) {
    const keepSlash = opts.slash && activePop && activePop._slash;
    if (activePop && !keepSlash) closePop();
    let pop = keepSlash ? activePop : null;
    if (!pop) {
      pop = h('div', { class: 'pop ' + (opts.cls || '') });
      document.body.append(pop);
    }
    pop.innerHTML = '';
    pop.append(content);
    pop._slash = !!opts.slash;
    pop._keyNav = opts.keyNav !== false;
    pop._onClose = opts.onClose;
    activePop = pop;
    placePop(pop, anchor);
    return pop;
  }

  function menu(anchor, items, opts = {}) {
    const frag = document.createDocumentFragment();
    for (const it of items) {
      if (it.sep) { frag.append(h('hr')); continue; }
      if (it.heading) { frag.append(h('div', { class: 'pop-label', text: it.label })); continue; }
      const btn = h('button', { class: 'mi' + (it.danger ? ' danger' : '') },
        it.html ? h('span', { html: it.html, style: 'display:contents' }) : h('span', { class: 'mi-ic sm', text: it.icon || '' }),
        it.desc ? h('span', { class: 'mi-t' }, h('span', { text: it.label }), h('span', { class: 'mi-d', text: it.desc })) : h('span', { text: it.label }),
        it.kbd && h('span', { class: 'mi-k', text: it.kbd }),
        it.check && h('span', { class: 'check', text: '✓' }));
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => { closePop(); it.action && it.action(); });
      frag.append(btn);
    }
    const pop = openPop(anchor, frag, opts);
    const first = $('.mi', pop);
    if (first && opts.slash) first.classList.add('hot');
    return pop;
  }

  function setupPopKeys() {
    document.addEventListener('keydown', (e) => {
      if (!activePop || !activePop._keyNav) return;
      const items = $$('.mi', activePop);
      const hot = items.findIndex((x) => x.classList.contains('hot'));
      const set = (i) => { items.forEach((x) => x.classList.remove('hot')); if (items[i]) { items[i].classList.add('hot'); items[i].scrollIntoView({ block: 'nearest' }); } };
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); set(items.length ? (hot + 1) % items.length : -1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); set(items.length ? (hot - 1 + items.length) % items.length : -1); }
      else if ((e.key === 'Enter' || e.key === 'Tab') && hot >= 0) { e.preventDefault(); e.stopPropagation(); items[hot].click(); }
      else if (e.key === 'Enter' && activePop._slash) { e.preventDefault(); e.stopPropagation(); closeSlash(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); slash ? closeSlash() : closePop(); }
    }, true);
    document.addEventListener('mousedown', (e) => {
      if (activePop && !activePop.contains(e.target)) { slash = null; closePop(); }
    }, true);
    window.addEventListener('resize', () => { closePop(); hideFormatBar(); });
    $('#scroller').addEventListener('scroll', () => { if (activePop && !activePop._slash) closePop(); });
  }

  function emojiPicker(anchor, onPick, allowRemove = true) {
    const grid = h('div', { class: 'emoji-grid' }, EMOJIS.map((em) => h('button', { text: em, onclick: () => { closePop(); onPick(em); } })));
    const input = h('input', { placeholder: 'Pega cualquier emoji y pulsa Enter', maxlength: '8' });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim()) { closePop(); onPick(input.value.trim()); } if (e.key === 'Escape') closePop(); });
    const content = h('div', null,
      h('div', { class: 'emoji-tools' }, input,
        h('button', { class: 'btn', text: '🎲', title: 'Aleatorio', onclick: () => { closePop(); onPick(EMOJIS[Math.floor(Math.random() * EMOJIS.length)]); } }),
        allowRemove && h('button', { class: 'btn', text: 'Quitar', onclick: () => { closePop(); onPick(''); } })),
      grid);
    openPop(anchor, content, { cls: 'emoji-pop', keyNav: false });
    input.focus();
  }

  function coverPicker(anchor) {
    const url = h('input', { type: 'url', placeholder: 'URL de una imagen…' });
    const file = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    const setCover = (c) => { cur().cover = c; touchPage(); closePop(); renderPage(); };
    file.onchange = () => file.files[0] && readImage(file.files[0], setCover);
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter' && /^https?:/i.test(url.value.trim())) setCover(url.value.trim()); });
    const content = h('div', { style: 'width:320px' },
      h('div', { class: 'pop-label', text: 'Degradados' }),
      h('div', { class: 'cover-grid' }, COVERS.map((c) => h('button', { style: `background:${c}`, onclick: () => setCover(c) }))),
      h('div', { class: 'pop-label', text: 'Imagen' }),
      h('div', { class: 'cover-url' }, url, h('button', { class: 'btn', text: 'Subir', onclick: () => file.click() }), file));
    openPop(anchor, content, { keyNav: false });
  }

  // ====================================================================
  // Modales: búsqueda, papelera, ajustes
  // ====================================================================
  let activeModal = null;
  function openModal(content, onClose) {
    closeModal();
    closePop();
    const bg = h('div', { class: 'modal-bg' }, content);
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) closeModal(); });
    bg._onClose = onClose;
    $('#overlay-root').append(bg);
    activeModal = bg;
    return bg;
  }
  function closeModal() {
    if (!activeModal) return;
    const m = activeModal;
    activeModal = null;
    m.remove();
    m._onClose && m._onClose();
  }

  function openSearch() {
    const input = h('input', { class: 'search-in', placeholder: 'Busca en tus páginas…' });
    const res = h('div', { class: 'search-res' });
    let hot = 0, results = [];
    const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const run = () => {
      const q = norm(input.value.trim());
      const pages = Object.values(ws.pages).filter((p) => !isTrashedDeep(p));
      if (!q) results = pages.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10).map((p) => ({ p }));
      else {
        results = [];
        for (const p of pages) {
          const t = norm(pageTitle(p));
          let score = t.includes(q) ? (t.startsWith(q) ? 3 : 2) : 0;
          let snippet = '';
          for (const b of p.blocks) {
            const txt = b.type === 'code' ? b.text : htmlToText(b.text) + ' ' + htmlToText(b.body || '');
            const i = norm(txt).indexOf(q);
            if (i >= 0) { score = score || 1; snippet = txt.slice(Math.max(0, i - 40), i + q.length + 60); break; }
          }
          if (score) results.push({ p, score, snippet });
        }
        results.sort((a, b) => b.score - a.score || b.p.updatedAt - a.p.updatedAt);
      }
      hot = 0;
      draw(q);
    };
    const mark = (text, q) => {
      if (!q) return esc(text);
      const i = norm(text).indexOf(q);
      return i < 0 ? esc(text) : esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
    };
    const draw = (q) => {
      res.innerHTML = '';
      if (!results.length) { res.append(h('div', { class: 'pop-empty', text: 'Sin resultados' })); return; }
      if (!q) res.append(h('div', { class: 'pop-label', text: 'Recientes' }));
      results.forEach((r, i) => {
        const path = ancestors(r.p).map(pageTitle).join(' / ');
        res.append(h('div', { class: 'sr' + (i === hot ? ' hot' : ''), onclick: () => { closeModal(); go(r.p.id); }, onmousemove: () => { if (hot !== i) { hot = i; $$('.sr', res).forEach((x, k) => x.classList.toggle('hot', k === i)); } } },
          h('span', { text: pageIcon(r.p) }),
          h('div', null,
            h('div', { class: 'sr-t', html: mark(pageTitle(r.p), q) }),
            path && h('div', { class: 'sr-p', text: path }),
            r.snippet && h('div', { class: 'sr-x', html: '…' + mark(r.snippet, q) + '…' }))));
      });
    };
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        hot = (hot + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(1, results.length);
        $$('.sr', res).forEach((x, k) => x.classList.toggle('hot', k === hot));
        $$('.sr', res)[hot]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && results[hot]) { closeModal(); go(results[hot].p.id); }
      else if (e.key === 'Escape') closeModal();
    });
    openModal(h('div', { class: 'modal' }, input, res));
    run();
    input.focus();
  }

  function openTrash() {
    const filter = h('input', { class: 'search-in', placeholder: 'Filtrar páginas en la papelera…' });
    const list = h('div', { class: 'modal-b' });
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      const items = Object.values(ws.pages).filter((p) => p.trashed && !(p.parentId && isTrashedDeep(getPage(p.parentId))) && pageTitle(p).toLowerCase().includes(q)).sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0));
      list.innerHTML = '';
      if (!items.length) { list.append(h('div', { class: 'pop-empty', text: 'La papelera está vacía' })); return; }
      for (const p of items) {
        list.append(h('div', { class: 'trash-row' },
          h('span', { text: pageIcon(p) }),
          h('span', { class: 'tt', text: pageTitle(p) }),
          h('span', { class: 'muted', text: fmtDate(p.trashedAt) }),
          h('button', { class: 'btn', text: 'Restaurar', onclick: () => { restorePage(p.id); draw(); } }),
          h('button', { class: 'btn danger', text: 'Eliminar', onclick: () => { if (confirm(`¿Eliminar “${pageTitle(p)}” para siempre? No se puede deshacer.`)) { deleteForever(p.id); renderBlocks(); draw(); } } })));
      }
    };
    filter.addEventListener('input', draw);
    filter.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal());
    openModal(h('div', { class: 'modal' },
      h('div', { class: 'modal-h' }, '🗑️ Papelera',
        h('button', { class: 'btn danger', style: 'margin-left:auto;margin-right:8px', text: 'Vaciar papelera', onclick: () => {
          const items = Object.values(ws.pages).filter((p) => p.trashed && !(p.parentId && isTrashedDeep(getPage(p.parentId))));
          if (items.length && confirm(`¿Eliminar ${items.length} página(s) para siempre?`)) { items.forEach((p) => deleteForever(p.id)); renderBlocks(); draw(); }
        } }),
        h('button', { class: 'icon-btn', text: '✕', onclick: closeModal })),
      filter, list));
    draw();
    filter.focus();
  }

  function openSettings() {
    const seg = h('div', { class: 'seg' }, [['light', 'Claro'], ['dark', 'Oscuro'], ['system', 'Sistema']].map(([v, l]) =>
      h('button', { class: ws.settings.theme === v ? 'on' : '', text: l, onclick: (e) => { ws.settings.theme = v; applyTheme(); wsSaver.touch(); $$('button', seg).forEach((b) => b.classList.remove('on')); e.target.classList.add('on'); } })));
    const name = h('input', { value: ws.settings.name || '', style: 'padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--bg);width:180px' });
    name.addEventListener('input', () => { ws.settings.name = name.value; wsSaver.touch(); renderSidebar(); });
    const importInput = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden' });
    importInput.onchange = async () => {
      const file = importInput.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const w = data.workspace || data;
        if (!w.pages || !w.rootIds) throw new Error('formato');
        if (!confirm('Esto reemplazará todas tus páginas actuales por las de la copia. ¿Continuar?')) return;
        ws = migrate(w);
        if (data.drafts && data.drafts.items) { drafts = data.drafts; draftSaver.touch(); renderQN(); }
        wsSaver.touch();
        closeModal();
        applySettings();
        route();
        toast('Copia de seguridad importada');
      } catch { alert('El archivo no es una copia de seguridad válida de NodeVX.'); }
    };
    const where = Store.mode === 'server' ? Store.info.dataDir : 'Almacenamiento del navegador (localStorage)';
    const shortcuts = [
      ['Ctrl+K / Ctrl+P', 'Buscar'], ['Alt+N', 'Abrir/cerrar notas rápidas'], ['Alt+P', 'Nueva página'], ['Ctrl+\\', 'Mostrar/ocultar barra lateral'],
      ['/', 'Menú de bloques'], ['Ctrl+B / I / U', 'Negrita / cursiva / subrayado'], ['Ctrl+E', 'Código en línea'], ['Ctrl+Shift+S', 'Tachado'], ['Ctrl+K (con selección)', 'Enlace'],
      ['Tab / Shift+Tab', 'Sangrar / quitar sangría'], ['Ctrl+D', 'Duplicar bloque'], ['Ctrl+Shift+↑/↓', 'Mover bloque'], ['Ctrl+Alt+0…9', 'Convertir bloque (texto, H1-H3, tareas…)'],
      ['Ctrl+Enter', 'Marcar tarea / abrir desplegable'], ['Shift+Enter', 'Salto de línea dentro del bloque'], ['Ctrl+S', 'Guardar ahora'],
    ];
    openModal(h('div', { class: 'modal' },
      h('div', { class: 'modal-h' }, '⚙️ Ajustes', h('button', { class: 'icon-btn', text: '✕', onclick: closeModal })),
      h('div', { class: 'modal-b' },
        h('div', { class: 'set-row' }, h('div', null, h('div', { class: 'st', text: 'Nombre del espacio' })), name),
        h('div', { class: 'set-row' }, h('div', null, h('div', { class: 'st', text: 'Apariencia' }), h('div', { class: 'sd', text: 'Tema claro, oscuro o el del sistema.' })), seg),
        h('div', { class: 'set-row' }, h('div', null, h('div', { class: 'st', text: 'Ubicación de los datos' }), h('div', { class: 'sd', text: where }))),
        h('div', { class: 'set-row' }, h('div', null, h('div', { class: 'st', text: 'Copia de seguridad' }), h('div', { class: 'sd', text: 'Exporta o importa todas tus páginas y notas rápidas en un archivo JSON.' })),
          h('div', { style: 'display:flex;gap:6px' },
            h('button', { class: 'btn', text: 'Exportar', onclick: () => download(`NodeVX-copia-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'NodeVX', exportedAt: new Date().toISOString(), workspace: ws, drafts }, null, 1), 'application/json') }),
            h('button', { class: 'btn', text: 'Importar', onclick: () => importInput.click() }), importInput)),
        h('div', { class: 'set-row', style: 'display:block' }, h('div', { class: 'st', text: 'Atajos de teclado', style: 'margin-bottom:8px' }),
          h('div', { class: 'kbd-list' }, shortcuts.map(([k, d]) => [h('kbd', { text: k }), h('span', { text: d })]))),
        h('div', { class: 'set-row' }, h('div', { class: 'sd', text: `NodeVX ${Store.info?.version || ''} · ${Object.keys(ws.pages).length} páginas` })))));
  }

  // ====================================================================
  // Exportar Markdown
  // ====================================================================
  function htmlToMd(html) {
    const t = document.createElement('template');
    t.innerHTML = html || '';
    const walk = (n) => [...n.childNodes].map((c) => {
      if (c.nodeType === 3) return c.textContent;
      if (c.nodeType !== 1) return '';
      const inner = walk(c);
      switch (c.tagName) {
        case 'B': case 'STRONG': return inner.trim() ? `**${inner}**` : inner;
        case 'I': case 'EM': return inner.trim() ? `*${inner}*` : inner;
        case 'S': case 'DEL': case 'STRIKE': return `~~${inner}~~`;
        case 'CODE': return '`' + inner + '`';
        case 'A': return `[${inner}](${c.getAttribute('href')})`;
        case 'BR': return '\n';
        default: return inner;
      }
    }).join('');
    return walk(t.content);
  }

  function pageToMarkdown(p) {
    const out = [`# ${p.icon ? p.icon + ' ' : ''}${pageTitle(p)}`, ''];
    let n = {};
    for (const b of p.blocks) {
      const pad = '  '.repeat(b.indent || 0);
      const md = htmlToMd(b.text).replace(/\n/g, '\n' + pad + '  ');
      if (b.type !== 'number') n = {};
      switch (b.type) {
        case 'h1': out.push(`## ${md}`, ''); break;
        case 'h2': out.push(`### ${md}`, ''); break;
        case 'h3': out.push(`#### ${md}`, ''); break;
        case 'bullet': out.push(`${pad}- ${md}`); break;
        case 'number': n[b.indent] = (n[b.indent] || 0) + 1; out.push(`${pad}${n[b.indent]}. ${md}`); break;
        case 'todo': out.push(`${pad}- [${b.checked ? 'x' : ' '}] ${md}`); break;
        case 'toggle': out.push(`${pad}<details><summary>${md}</summary>`, '', htmlToMd(b.body || ''), '</details>', ''); break;
        case 'quote': out.push(`> ${md.replace(/\n/g, '\n> ')}`, ''); break;
        case 'callout': out.push(`> ${b.icon || '💡'} ${md.replace(/\n/g, '\n> ')}`, ''); break;
        case 'code': out.push('```' + (b.lang && b.lang !== 'plain' ? b.lang : ''), b.text, '```', ''); break;
        case 'divider': out.push('---', ''); break;
        case 'page': { const sp = getPage(b.pageId); out.push(`${pageIcon(sp)} **${pageTitle(sp)}** (subpágina)`, ''); break; }
        case 'image': if (b.src && !b.src.startsWith('data:')) out.push(`![${htmlToText(b.text)}](${b.src})`, ''); else if (b.src) out.push(`*(imagen incrustada)* ${htmlToText(b.text)}`, ''); break;
        default: out.push(pad + md, '');
      }
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function exportMarkdown(id) {
    const p = getPage(id);
    download(safeFileName(pageTitle(p)) + '.md', pageToMarkdown(p), 'text/markdown');
  }

  // ====================================================================
  // Notas rápidas (borrador local)
  // ====================================================================
  const activeDraft = () => drafts.items.find((d) => d.id === drafts.activeId) || drafts.items[0];
  const draftLabel = (d) => (d.text.split('\n').find((l) => l.trim()) || '').replace(/^#+\s*/, '').trim().slice(0, 24) || 'Borrador vacío';

  function mirrorDrafts() { try { localStorage.setItem('nodevx:drafts-mirror', JSON.stringify(drafts)); } catch { /* lleno */ } }
  function touchDrafts() { mirrorDrafts(); draftSaver.touch(); }

  function renderQN() {
    if (!drafts.items.length) Object.assign(drafts, defaultDrafts());
    const d = activeDraft();
    drafts.activeId = d.id;
    const tabs = $('#qn-tabs');
    tabs.innerHTML = '';
    for (const x of drafts.items) {
      tabs.append(h('button', { class: 'qn-tab' + (x.id === d.id ? ' on' : ''), text: draftLabel(x), title: `Editado: ${fmtDate(x.updatedAt)}`, onclick: () => { drafts.activeId = x.id; touchDrafts(); renderQN(); $('#qn-text').focus(); } }));
    }
    tabs.append(h('button', { class: 'qn-tab add', text: '＋ Nuevo', title: 'Nuevo borrador', onclick: () => {
      const nd = { id: uid(), text: '', createdAt: now(), updatedAt: now() };
      drafts.items.unshift(nd); drafts.activeId = nd.id; touchDrafts(); renderQN(); $('#qn-text').focus();
    } }));
    const ta = $('#qn-text');
    if (ta.value !== d.text) ta.value = d.text;
    updateQNCount();
  }

  function updateQNCount() {
    const t = activeDraft().text;
    const words = (t.trim().match(/\S+/g) || []).length;
    $('#qn-count').textContent = `${words} palabra${words === 1 ? '' : 's'} · ${t.length} caracteres · editado ${fmtDate(activeDraft().updatedAt)}`;
  }

  function toggleQuickNotes(force) {
    const open = force ?? !document.body.classList.contains('qn-open');
    document.body.classList.toggle('qn-open', open);
    ws.settings.qnOpen = open;
    wsSaver.touch();
    if (open) { renderQN(); setTimeout(() => $('#qn-text').focus(), 50); }
  }

  function setupQuickNotes() {
    const ta = $('#qn-text');
    ta.addEventListener('input', () => {
      const d = activeDraft();
      d.text = ta.value;
      d.updatedAt = now();
      touchDrafts();
      const tab = $('.qn-tab.on');
      if (tab) tab.textContent = draftLabel(d);
      updateQNCount();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { toggleQuickNotes(false); }
      if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
    });
    ta.addEventListener('blur', () => draftSaver.flush());
    $('#qn-close').onclick = () => toggleQuickNotes(false);
    $('#qn-copy').onclick = () => copyText(activeDraft().text).then(() => toast('Borrador copiado al portapapeles'));
    $('#qn-delete').onclick = () => {
      const d = activeDraft();
      if (d.text.trim() && !confirm('¿Eliminar este borrador?')) return;
      drafts.items = drafts.items.filter((x) => x.id !== d.id);
      if (!drafts.items.length) Object.assign(drafts, defaultDrafts());
      drafts.activeId = drafts.items[0].id;
      touchDrafts();
      renderQN();
    };
    $('#qn-convert').onclick = () => {
      const d = activeDraft();
      if (!d.text.trim()) { toast('El borrador está vacío'); return; }
      const lines = d.text.split('\n');
      const firstIdx = lines.findIndex((l) => l.trim());
      const title = lines[firstIdx].replace(/^#+\s*/, '').trim().slice(0, 200);
      const blocks = parseMarkdown(lines.slice(firstIdx + 1).join('\n'));
      const p = createPage(null, { title, icon: '⚡' });
      p.blocks = blocks.length ? blocks : [newBlock()];
      touchPage(p);
      go(p.id);
      toast('Página creada a partir del borrador', 'Vaciar borrador', () => {
        d.text = ''; d.updatedAt = now(); touchDrafts(); renderQN();
      });
    };
  }

  // ====================================================================
  // Varios
  // ====================================================================
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); }
    catch {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = t; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
  }

  let toastTimer = 0;
  function toast(msg, actionLabel, action) {
    const el = $('#toast');
    el.innerHTML = '';
    el.append(h('span', { text: msg }));
    if (actionLabel) el.append(h('button', { text: actionLabel, onclick: () => { el.classList.add('hidden'); action(); } }));
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), actionLabel ? 6000 : 2500);
  }

  const mq = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const t = ws.settings.theme === 'system' ? (mq.matches ? 'dark' : 'light') : ws.settings.theme;
    document.documentElement.dataset.theme = t;
  }
  mq.addEventListener('change', () => ws && applyTheme());

  function applySettings() {
    applyTheme();
    document.documentElement.style.setProperty('--sbw', (ws.settings.sidebarWidth || 260) + 'px');
    document.body.classList.toggle('sb-collapsed', !!ws.settings.sidebarCollapsed);
    document.body.classList.toggle('qn-open', !!ws.settings.qnOpen);
  }

  function setupGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && (k === 'k' || k === 'p') && !e.shiftKey && !e.altKey) { e.preventDefault(); activeModal ? closeModal() : openSearch(); return; }
      if (e.altKey && !mod && (e.code === 'KeyN')) { e.preventDefault(); toggleQuickNotes(); return; }
      if (e.altKey && !mod && (e.code === 'KeyP')) { e.preventDefault(); const p = createPage(null); go(p.id); focusTitle(); return; }
      if (mod && e.key === '\\') { e.preventDefault(); toggleSidebar(); return; }
      if (mod && k === 's') { e.preventDefault(); wsSaver.flush(); draftSaver.flush(); toast('Guardado'); return; }
      if (e.key === 'Escape' && activeModal) { closeModal(); return; }
    });
  }

  function setupLifecycle() {
    const flushAll = () => { wsSaver.beacon(); draftSaver.beacon(); };
    window.addEventListener('pagehide', () => {
      flushAll();
      if (Store.mode === 'server') navigator.sendBeacon('api/bye', '');
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { wsSaver.flush(); draftSaver.flush(); } });
    if (Store.mode === 'server') {
      const beat = () => fetch('api/heartbeat', { method: 'POST' }).catch(() => {
        $('#save-status').textContent = '⚠ Sin conexión con NodeVX';
      });
      beat();
      setInterval(beat, 5000);
    }
    const onNav = () => { const m = location.hash.match(/^#\/p\/([\w-]+)$/); if (!m || m[1] !== currentId) route(); };
    window.addEventListener('hashchange', onNav);
    window.addEventListener('popstate', onNav);
  }

  // ====================================================================
  // Arranque
  // ====================================================================
  async function boot() {
    await Store.init();
    try {
      ws = await Store.load('workspace');
    } catch (e) {
      readOnly = true;
      alert('No se pudieron leer tus datos (' + e.message + '). La app se abrirá en modo solo lectura para no sobrescribir nada.');
    }
    const fresh = !ws;
    ws = migrate(ws || defaultWorkspace());
    try { drafts = await Store.load('drafts'); } catch { drafts = null; }
    if (!drafts || !Array.isArray(drafts.items)) {
      try { drafts = JSON.parse(localStorage.getItem('nodevx:drafts-mirror')); } catch { drafts = null; }
    }
    if (!drafts || !Array.isArray(drafts.items) || !drafts.items.length) drafts = defaultDrafts();

    applySettings();
    setupSidebar();
    setupTopbar();
    setupEditor();
    setupFormatBar();
    setupPopKeys();
    setupQuickNotes();
    setupGlobalKeys();
    setupLifecycle();
    renderQN();
    route();
    if (fresh && !readOnly) wsSaver.touch();
    if (Store.mode === 'local' && location.protocol === 'file:') console.info('NodeVX: modo navegador, los datos se guardan en localStorage.');
  }

  boot();
})();
