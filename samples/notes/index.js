// samples/notes/index.js
//
// 文本速记 —— Modulith 示例插件。
//
// 它示范的是一个「完整但仍只用一项权限」的插件该长什么样：只用 `storage`，
// 却做出了列表、全文搜索、置顶、排序、自动保存与快捷键。
//
// 三处值得单独看的设计，都在下文有注释：
//   1. **正文与索引分开存** —— 否则改一个字就要重写全部正文。
//   2. **自动保存是防抖的，并且在模块被切走时立刻落盘** —— 保活让模块继续活着，
//      但用户随时可能关窗。
//   3. **全文搜索按需加载全部正文** —— 搜索要搜全文，但不能为了搜索把正文
//      塞进索引里（那等于回到问题 1）。
//
// 为什么是手写 IIFE：示例的价值在于可读、可复制。代价是不能用 JSX，
// 因此全部用 `React.createElement`（简写为 `h`）。
//
// 本示例以 MIT 许可提供，欢迎直接复制作为你自己插件的起点。

(function () {
  'use strict';

  var Modulith = window.Modulith;
  if (!Modulith) {
    console.error('[notes] 未找到 window.Modulith，插件无法加载');
    return;
  }

  var React = Modulith.React;
  var h = React.createElement;

  // createContext() 只能在加载期调用，因此在这里取一次并长期持有。
  var ctx = Modulith.createContext();

  /** 索引：条目元数据 + 选中项 + 排序方式 */
  var INDEX_KEY = 'notes';
  /**
   * 单条正文各占一个键。
   *
   * 为什么不把正文塞进索引：改一个字就要重写整份数据（所有条目的全部正文）。
   * 分开之后，打字只写当前这一条，索引始终保持很小。
   *
   * 键名用 `note.` 而不是 `note:` —— 存储键只允许字母数字与 `.` `_` `-`。
   */
  var BODY_PREFIX = 'note.';

  /** 自动保存延迟（毫秒）。太短会让打字时频繁写盘，太长则丢字风险变大 */
  var AUTOSAVE_DELAY = 600;

  var SORTS = [
    { id: 'updated', label: '最近修改' },
    { id: 'created', label: '最近创建' },
    { id: 'title', label: '按标题' },
  ];

  // ============================================================
  // 小工具
  // ============================================================

  function newId() {
    return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /** 列表里显示的一行摘要：压平换行并截断 */
  function previewOf(body) {
    var flat = String(body || '')
      .replace(/\s+/g, ' ')
      .trim();
    return flat.length > 80 ? flat.slice(0, 80) + '…' : flat;
  }

  /** 无标题时用正文首行顶上，避免列表里一排「无标题」 */
  function displayTitle(item) {
    if (item.title && item.title.trim()) return item.title;
    var p = previewOf(item.preview);
    return p || '无标题';
  }

  function formatRelative(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    var minute = 60000;
    var hour = 60 * minute;
    var day = 24 * hour;
    if (diff < minute) return '刚刚';
    if (diff < hour) return Math.floor(diff / minute) + ' 分钟前';
    if (diff < day) return Math.floor(diff / hour) + ' 小时前';
    if (diff < 30 * day) return Math.floor(diff / day) + ' 天前';
    return new Date(ts).toLocaleDateString();
  }

  function formatFull(ts) {
    return ts ? new Date(ts).toLocaleString() : '未知';
  }

  function emptyIndex() {
    return { version: 1, items: [], selectedId: null, sort: 'updated' };
  }

  /** 读到任何东西都整理成当前结构 —— 读的时候容错比写的时候谨慎更重要 */
  function normalizeIndex(raw) {
    if (!raw || typeof raw !== 'object') return emptyIndex();
    var index = emptyIndex();
    index.items = (Array.isArray(raw.items) ? raw.items : []).map(function (item) {
      var created = typeof item.createdAt === 'number' ? item.createdAt : Date.now();
      return {
        id: item.id || newId(),
        title: typeof item.title === 'string' ? item.title : '',
        preview: typeof item.preview === 'string' ? item.preview : '',
        pinned: Boolean(item.pinned),
        createdAt: created,
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : created,
      };
    });
    index.selectedId =
      typeof raw.selectedId === 'string' &&
      index.items.some(function (i) {
        return i.id === raw.selectedId;
      })
        ? raw.selectedId
        : null;
    index.sort = SORTS.some(function (s) {
      return s.id === raw.sort;
    })
      ? raw.sort
      : 'updated';
    return index;
  }

  // ============================================================
  // 主界面
  // ============================================================

  function Notes() {
    var indexPair = React.useState(null);
    var index = indexPair[0];
    var setIndex = indexPair[1];

    var draftPair = React.useState(null);
    var draft = draftPair[0];
    var setDraft = draftPair[1];

    var queryPair = React.useState('');
    var query = queryPair[0];
    var setQuery = queryPair[1];

    var errorPair = React.useState('');
    var error = errorPair[0];
    var setError = errorPair[1];

    var savedPair = React.useState(0);
    var savedAt = savedPair[0];
    var setSavedAt = savedPair[1];

    var bodiesPair = React.useState(false);
    var bodiesReady = bodiesPair[0];
    var setBodiesReady = bodiesPair[1];

    // refs：让防抖回调与「切走时落盘」始终读到最新值，而不必重建闭包
    var indexRef = React.useRef(null);
    var draftRef = React.useRef(null);
    var timerRef = React.useRef(null);
    /** 全文搜索用的正文缓存：id -> body */
    var bodiesRef = React.useRef({});

    React.useEffect(
      function () {
        indexRef.current = index;
      },
      [index]
    );

    // ---- 载入 ----
    React.useEffect(function () {
      var alive = true;
      ctx.storage
        .get(INDEX_KEY, null)
        .then(function (raw) {
          if (!alive) return;
          var loaded = normalizeIndex(raw);
          indexRef.current = loaded;
          setIndex(loaded);
          // 恢复上次选中的条目
          if (loaded.selectedId) {
            return ctx.storage.get(BODY_PREFIX + loaded.selectedId, '').then(function (body) {
              if (!alive) return;
              var item = loaded.items.filter(function (i) {
                return i.id === loaded.selectedId;
              })[0];
              var d = {
                id: loaded.selectedId,
                title: item ? item.title : '',
                body: typeof body === 'string' ? body : '',
              };
              draftRef.current = d;
              setDraft(d);
            });
          }
          return undefined;
        })
        .catch(function (e) {
          if (!alive) return;
          setError('读取已保存的内容失败：' + e);
          var fallback = emptyIndex();
          indexRef.current = fallback;
          setIndex(fallback);
        });
      return function () {
        alive = false;
      };
    }, []);

    // ---- 保存 ----
    /** 立刻落盘：写当前正文 + 把索引里对应条目的标题/摘要/时间更新掉 */
    var flushSave = React.useCallback(function () {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      var d = draftRef.current;
      var prev = indexRef.current;
      if (!d || !prev) return;

      ctx.storage.set(BODY_PREFIX + d.id, d.body).catch(function (e) {
        setError('保存正文失败：' + e);
      });

      var next = Object.assign({}, prev, {
        items: prev.items.map(function (item) {
          if (item.id !== d.id) return item;
          return Object.assign({}, item, {
            title: (d.title || '').trim(),
            preview: previewOf(d.body),
            updatedAt: Date.now(),
          });
        }),
      });
      indexRef.current = next;
      setIndex(next);

      ctx.storage
        .set(INDEX_KEY, next)
        .then(function () {
          setSavedAt(Date.now());
        })
        .catch(function (e) {
          setError('保存索引失败：' + e);
        });
    }, []);

    var scheduleSave = React.useCallback(
      function () {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(flushSave, AUTOSAVE_DELAY);
      },
      [flushSave]
    );

    // 模块被切走时立刻落盘。
    // 保活意味着切走不会卸载，但用户随时可能关窗 —— 那 600ms 的防抖窗口里
    // 的内容就没了。这一条是「自动保存」真正可靠的保证。
    var active = Modulith.useModuleActive();
    React.useEffect(
      function () {
        if (active) return undefined;
        flushSave();
        return undefined;
      },
      [active, flushSave]
    );

    // 卸载时也落一次盘（例如用户点了标题栏的刷新）
    React.useEffect(
      function () {
        return function () {
          flushSave();
        };
      },
      [flushSave]
    );

    // ---- 全文搜索用的正文缓存 ----
    // 只在真正开始搜索时才把正文读进内存，平时完全不读 ——
    // 代价是第一次搜索有一次短暂的加载。
    React.useEffect(
      function () {
        if (!index || bodiesReady) return undefined;
        if (!query.trim()) return undefined;

        var alive = true;
        Promise.all(
          index.items.map(function (item) {
            return ctx.storage.get(BODY_PREFIX + item.id, '').then(function (body) {
              bodiesRef.current[item.id] = typeof body === 'string' ? body : '';
            });
          })
        )
          .then(function () {
            if (alive) setBodiesReady(true);
          })
          .catch(function () {
            // 读不到就退化为「只搜标题与摘要」，不该让整个搜索不可用
            if (alive) setBodiesReady(true);
          });
        return function () {
          alive = false;
        };
      },
      [index, query, bodiesReady]
    );

    // 条目增减后缓存会失效，重新按需加载
    var itemIds = index
      ? index.items
          .map(function (i) {
            return i.id;
          })
          .join(',')
      : '';
    React.useEffect(
      function () {
        setBodiesReady(false);
        bodiesRef.current = {};
      },
      [itemIds]
    );

    // ---- 操作 ----
    function editDraft(patch) {
      var next = Object.assign({}, draftRef.current, patch);
      draftRef.current = next;
      setDraft(next);
      scheduleSave();
    }

    function persistSelection(id) {
      var prev = indexRef.current;
      if (!prev || prev.selectedId === id) return;
      var next = Object.assign({}, prev, { selectedId: id });
      indexRef.current = next;
      setIndex(next);
      ctx.storage.set(INDEX_KEY, next).catch(function () {});
    }

    function select(id) {
      if (draftRef.current && draftRef.current.id !== id) flushSave();
      if (draftRef.current && draftRef.current.id === id) return;

      ctx.storage.get(BODY_PREFIX + id, '').then(function (body) {
        var item = (indexRef.current ? indexRef.current.items : []).filter(function (i) {
          return i.id === id;
        })[0];
        var d = {
          id: id,
          title: item ? item.title : '',
          body: typeof body === 'string' ? body : '',
        };
        draftRef.current = d;
        setDraft(d);
        bodiesRef.current[id] = d.body;
        persistSelection(id);
      });
    }

    var create = React.useCallback(
      function () {
        if (draftRef.current) flushSave();
        var id = newId();
        var now = Date.now();
        var prev = indexRef.current || emptyIndex();
        var next = Object.assign({}, prev, {
          selectedId: id,
          sort: 'updated',
          items: [
            {
              id: id,
              title: '',
              preview: '',
              pinned: false,
              createdAt: now,
              updatedAt: now,
            },
          ].concat(prev.items),
        });
        indexRef.current = next;
        setIndex(next);
        ctx.storage.set(INDEX_KEY, next).catch(function (e) {
          setError('保存失败：' + e);
        });

        var d = { id: id, title: '', body: '' };
        draftRef.current = d;
        setDraft(d);
      },
      [flushSave]
    );

    function remove(id) {
      var item = (indexRef.current ? indexRef.current.items : []).filter(function (i) {
        return i.id === id;
      })[0];
      var label = item ? displayTitle(item) : '这条速记';
      if (!window.confirm('删除「' + label + '」？此操作不可撤销。')) return;

      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (draftRef.current && draftRef.current.id === id) {
        // 丢掉待写入的草稿，否则防抖回调会把刚删掉的条目又写回索引
        draftRef.current = null;
        setDraft(null);
      }

      var prev = indexRef.current || emptyIndex();
      var next = Object.assign({}, prev, {
        selectedId: prev.selectedId === id ? null : prev.selectedId,
        items: prev.items.filter(function (i) {
          return i.id !== id;
        }),
      });
      indexRef.current = next;
      setIndex(next);

      ctx.storage.delete(BODY_PREFIX + id).catch(function () {});
      delete bodiesRef.current[id];
      ctx.storage.set(INDEX_KEY, next).catch(function (e) {
        setError('保存失败：' + e);
      });
    }

    function togglePin(id) {
      var prev = indexRef.current || emptyIndex();
      var next = Object.assign({}, prev, {
        items: prev.items.map(function (i) {
          return i.id === id ? Object.assign({}, i, { pinned: !i.pinned }) : i;
        }),
      });
      indexRef.current = next;
      setIndex(next);
      ctx.storage.set(INDEX_KEY, next).catch(function (e) {
        setError('保存失败：' + e);
      });
    }

    function setSort(sort) {
      var prev = indexRef.current || emptyIndex();
      var next = Object.assign({}, prev, { sort: sort });
      indexRef.current = next;
      setIndex(next);
      ctx.storage.set(INDEX_KEY, next).catch(function () {});
    }

    function copyCurrent() {
      if (!draftRef.current) return;
      var text = draftRef.current.body;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(function () {
            setSavedAt(Date.now());
          })
          .catch(function () {
            setError('复制失败，浏览器拒绝了剪贴板访问');
          });
      } else {
        setError('当前环境不支持剪贴板');
      }
    }

    // 快捷键：与宿主不冲突的组合（宿主只用 Ctrl+K / W / Tab / 1..9）。
    //
    // **必须判断模块是否可见。** keydown 挂在 window 上，是窗口级的：不判断的话，
    // 用户在别的模块里按 Ctrl+N，这里也会新建一条速记，而界面根本不在眼前。
    React.useEffect(
      function () {
        if (!active) return undefined;

        function onKey(event) {
          var mod = event.ctrlKey || event.metaKey;
          if (!mod) return;
          if (event.key === 'n' || event.key === 'N') {
            event.preventDefault();
            create();
          } else if (event.key === 's' || event.key === 'S') {
            event.preventDefault();
            flushSave();
          }
        }

        window.addEventListener('keydown', onKey);
        return function () {
          window.removeEventListener('keydown', onKey);
        };
      },
      [active, create, flushSave]
    );

    // ---- 派生列表 ----
    var q = query.trim().toLowerCase();
    var visible = (index ? index.items.slice() : []).filter(function (item) {
      if (!q) return true;
      if (displayTitle(item).toLowerCase().indexOf(q) >= 0) return true;
      var body = bodiesRef.current[item.id];
      return typeof body === 'string' && body.toLowerCase().indexOf(q) >= 0;
    });

    var sortKey = index ? index.sort : 'updated';
    visible.sort(function (a, b) {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (sortKey === 'title') return displayTitle(a).localeCompare(displayTitle(b), 'zh');
      if (sortKey === 'created') return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    });

    if (!index) {
      return h('div', { className: 'nt-root' }, h('div', { className: 'nt-empty' }, '读取中…'));
    }

    // ---- 渲染 ----
    var toolbar = h(
      'div',
      { className: 'nt-toolbar' },
      h('h1', { className: 'nt-title' }, '文本速记'),
      h('input', {
        className: 'nt-search',
        type: 'search',
        placeholder: '搜索标题与正文…',
        value: query,
        onChange: function (e) {
          setQuery(e.target.value);
        },
      }),
      h(
        'select',
        {
          className: 'nt-select',
          value: sortKey,
          title: '排序方式',
          onChange: function (e) {
            setSort(e.target.value);
          },
        },
        SORTS.map(function (s) {
          return h('option', { key: s.id, value: s.id }, s.label);
        })
      ),
      h('button', { className: 'nt-btn nt-btn-primary', type: 'button', onClick: create }, '新建')
    );

    var banner = error
      ? h(
          'div',
          { className: 'nt-error', role: 'alert' },
          h('span', { className: 'nt-error-text' }, error),
          h(
            'button',
            {
              className: 'nt-error-close',
              type: 'button',
              title: '关闭',
              onClick: function () {
                setError('');
              },
            },
            '×'
          )
        )
      : null;

    var list = h(
      'div',
      { className: 'nt-list' },
      visible.length === 0
        ? h(
            'div',
            { className: 'nt-empty' },
            index.items.length === 0 ? '还没有速记。点「新建」，或按 Ctrl+N。' : '没有匹配的速记。'
          )
        : visible.map(function (item) {
            var isActive = draft && draft.id === item.id;
            return h(
              'div',
              {
                key: item.id,
                className: 'nt-item' + (isActive ? ' nt-item-active' : ''),
                onClick: function () {
                  select(item.id);
                },
              },
              h(
                'div',
                { className: 'nt-item-head' },
                h('span', { className: 'nt-item-title' }, displayTitle(item)),
                item.pinned
                  ? h('span', { className: 'nt-item-pin', title: '已置顶' }, '★')
                  : null
              ),
              h('span', { className: 'nt-item-preview' }, item.preview || '（空）'),
              h(
                'div',
                { className: 'nt-item-foot' },
                h('span', { className: 'nt-item-time' }, formatRelative(item.updatedAt)),
                h(
                  'span',
                  { className: 'nt-item-actions' },
                  h(
                    'button',
                    {
                      className: 'nt-icon-btn',
                      type: 'button',
                      title: item.pinned ? '取消置顶' : '置顶',
                      onClick: function (e) {
                        e.stopPropagation();
                        togglePin(item.id);
                      },
                    },
                    item.pinned ? '★' : '☆'
                  ),
                  h(
                    'button',
                    {
                      className: 'nt-icon-btn nt-icon-btn-danger',
                      type: 'button',
                      title: '删除',
                      onClick: function (e) {
                        e.stopPropagation();
                        remove(item.id);
                      },
                    },
                    '×'
                  )
                )
              )
            );
          })
    );

    var editor;
    if (!draft) {
      editor = h(
        'div',
        { className: 'nt-editor nt-editor-empty' },
        h('p', null, visible.length > 0 ? '从左侧选一条开始编辑。' : '点「新建」开始写第一条速记。'),
        h('p', { className: 'nt-editor-hint' }, 'Ctrl+N 新建 · Ctrl+S 立即保存 · 输入会自动保存')
      );
    } else {
      editor = h(
        'div',
        { className: 'nt-editor' },
        h('input', {
          className: 'nt-editor-title',
          type: 'text',
          placeholder: '标题（可留空）',
          value: draft.title,
          onChange: function (e) {
            editDraft({ title: e.target.value });
          },
        }),
        h('textarea', {
          className: 'nt-editor-body',
          placeholder: '开始写…',
          value: draft.body,
          spellCheck: false,
          onChange: function (e) {
            editDraft({ body: e.target.value });
          },
        }),
        h(
          'div',
          { className: 'nt-editor-foot' },
          h(
            'span',
            { className: 'nt-editor-stat' },
            draft.body.length + ' 字符 · ' + (draft.body ? draft.body.split('\n').length : 0) + ' 行'
          ),
          savedAt
            ? h('span', { className: 'nt-editor-stat' }, '已保存 ' + formatRelative(savedAt))
            : h('span', { className: 'nt-editor-stat' }, '自动保存已开启'),
          h('span', { className: 'nt-editor-spacer' }),
          h(
            'button',
            { className: 'nt-btn nt-btn-ghost', type: 'button', onClick: copyCurrent },
            '复制全文'
          ),
          h(
            'button',
            {
              className: 'nt-btn nt-btn-ghost',
              type: 'button',
              onClick: function () {
                togglePin(draft.id);
              },
            },
            (function () {
              var current = index.items.filter(function (i) {
                return i.id === draft.id;
              })[0];
              return current && current.pinned ? '取消置顶' : '置顶';
            })()
          ),
          h(
            'button',
            { className: 'nt-btn nt-btn-ghost', type: 'button', onClick: flushSave },
            '立即保存'
          )
        )
      );
    }

    return h(
      'div',
      { className: 'nt-root' },
      toolbar,
      banner,
      h('div', { className: 'nt-body' }, list, editor),
      h(
        'div',
        { className: 'nt-footnote' },
        '共 ' + index.items.length + ' 条 · 数据保存在插件自己的存储中，卸载插件会一并清除'
      )
    );
  }

  Modulith.registerModule({
    id: 'notes',
    name: '文本速记',
    description: '随手记下想法、待办与片段',
    icon: 'NotebookPen',
    priority: 70,
    component: Notes,
  });
})();
