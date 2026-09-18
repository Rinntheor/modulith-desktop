// samples/notes/index.js
//
// 文本速记 —— 一个极简的速记收件箱。
//
// 设计取向：**速记不是写文档。**
//
// 所以这里刻意**没有**标题字段、没有编辑器面板、没有排序方式、没有分组。
// 只有：一个输入框 → 写 → 保存 → 内容落到下面成为一条。
// 每条可以复制、修改、删除。就这么简单。
//
// 为什么这个判断重要：如果给它加标题、加多字段编辑、加侧栏列表，那它就是在做
// 「文档管理」—— 而这件事系统里有更合适的工具。速记的价值在于**快**：
// 想法出现时不该先决定「它该叫什么名字、放哪个分类」。
// 因此内容本身就是唯一字段，第一条换行之前的文字自动当作标题显示。
//
// 两处与「插件」身份有关的技术点：
//   1. 输入内容（草稿）也持久化 —— 打了一半关掉窗口不该丢。
//   2. 保存是显式的（点按钮或 Ctrl+Enter），不做自动保存 ——
//      因为「点保存」正是这个交互的核心动作。草稿另有防抖落盘。
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

  /** 已保存的全部速记 */
  var KEY_ITEMS = 'items';
  /** 还没点「保存」的输入内容，单独存放 */
  var KEY_DRAFT = 'draft';

  /** 草稿的防抖落盘延迟。它只是防丢，因此没必要每次按键都写盘 */
  var DRAFT_SAVE_DELAY = 400;

  // ============================================================
  // 小工具
  // ============================================================

  function newId() {
    return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * 一条速记的显示标题：正文第一行。
   *
   * 没有独立的标题字段是有意的 —— 见文件头。第一行通常就是「这句话在说什么」，
   * 直接拿它当标题最省事，也不需要用户多做一次决定。
   */
  function titleOf(text) {
    var firstLine = String(text || '').split('\n')[0].trim();
    return firstLine || '（无内容）';
  }

  /** 第一条以外的内容，用于列表里显示摘要 */
  function remainderOf(text) {
    var lines = String(text || '').split('\n');
    if (lines.length <= 1) return '';
    return lines
      .slice(1)
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function sameDay(a, b) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  function formatTime(ts) {
    if (!ts) return '';
    var now = new Date();
    var then = new Date(ts);
    var hm = pad2(then.getHours()) + ':' + pad2(then.getMinutes());

    if (sameDay(now, then)) return '今天 ' + hm;
    if (sameDay(new Date(now.getTime() - 86400000), then)) return '昨天 ' + hm;

    return then.getFullYear() + '-' + (then.getMonth() + 1) + '-' + then.getDate() + ' ' + hm;
  }

  /**
   * 把读到的任何东西整理成速记数组。
   *
   * 读的时候容错比写的时候谨慎更重要：用户的数据只有一份，读失败就全丢了。
   * 这里也兼容早期的格式（那时每条是 `{id, title, body}` 两个字段），
   * 把 title 与 body 拼回一整段文本 —— 老用户的数据不该因为改版而消失。
   */
  function normalizeItems(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map(function (entry) {
        if (!entry || typeof entry !== 'object') return null;

        var text;
        if (typeof entry.text === 'string') {
          text = entry.text;
        } else if (typeof entry.body === 'string') {
          var title = typeof entry.title === 'string' ? entry.title.trim() : '';
          text = title ? title + '\n' + entry.body : entry.body;
        } else {
          return null;
        }

        var created = typeof entry.createdAt === 'number' ? entry.createdAt : Date.now();
        return {
          id: typeof entry.id === 'string' && entry.id ? entry.id : newId(),
          text: text,
          createdAt: created,
          updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : created,
        };
      })
      .filter(Boolean);
  }

  // ============================================================
  // 界面
  // ============================================================

  function Notes() {
    var itemsPair = React.useState(null);
    var items = itemsPair[0];
    var setItems = itemsPair[1];

    var draftPair = React.useState('');
    var draft = draftPair[0];
    var setDraft = draftPair[1];

    var editingPair = React.useState(null);
    var editing = editingPair[0];
    var setEditing = editingPair[1];

    var errorPair = React.useState('');
    var error = errorPair[0];
    var setError = errorPair[1];

    var toastPair = React.useState('');
    var toast = toastPair[0];
    var setToast = toastPair[1];

    var inputRef = React.useRef(null);
    // 最新值放 ref，供事件回调读取 —— 否则闭包会捕获旧数组，
    // 表现为「连点两次保存，第一条被覆盖」
    var itemsRef = React.useRef(null);
    var draftTimer = React.useRef(null);
    var toastTimer = React.useRef(null);

    React.useEffect(
      function () {
        itemsRef.current = items;
      },
      [items]
    );

    // ---- 载入 ----
    React.useEffect(function () {
      var alive = true;
      Promise.all([ctx.storage.get(KEY_ITEMS, null), ctx.storage.get(KEY_DRAFT, '')])
        .then(function (values) {
          if (!alive) return;
          setItems(normalizeItems(values[0]));
          setDraft(typeof values[1] === 'string' ? values[1] : '');
        })
        .catch(function (e) {
          if (!alive) return;
          setError('读取已保存的内容失败：' + e);
          setItems([]);
        });
      return function () {
        alive = false;
      };
    }, []);

    // ---- 轻提示 ----
    function flash(message) {
      setToast(message);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(function () {
        setToast('');
      }, 1800);
    }

    React.useEffect(function () {
      return function () {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        if (draftTimer.current) clearTimeout(draftTimer.current);
      };
    }, []);

    // ---- 草稿落盘（防抖）----
    // 打了一半的内容也要存下来：关掉窗口再回来，输入框里应当还在。
    function updateDraft(value) {
      setDraft(value);
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(function () {
        draftTimer.current = null;
        ctx.storage.set(KEY_DRAFT, value).catch(function () {});
      }, DRAFT_SAVE_DELAY);
    }

    /** 立刻把草稿写下去，不等防抖 */
    function flushDraft(value) {
      if (draftTimer.current) {
        clearTimeout(draftTimer.current);
        draftTimer.current = null;
      }
      ctx.storage.set(KEY_DRAFT, value).catch(function () {});
    }

    // 模块被切走时立刻落盘 —— 保活让模块继续运行，但用户随时会关窗
    var active = Modulith.useModuleActive();
    React.useEffect(
      function () {
        if (active) return undefined;
        flushDraft(draft);
        return undefined;
        // flushDraft 是稳定的（只依赖 ref），这里不必列出
        // eslint-disable-next-line react-hooks/exhaustive-deps
      },
      [active, draft]
    );

    // ---- 保存 / 复制 / 修改 / 删除 ----
    function persist(next) {
      itemsRef.current = next;
      setItems(next);
      ctx.storage.set(KEY_ITEMS, next).catch(function (e) {
        setError('保存失败：' + e);
      });
    }

    function save() {
      var text = draft.trim();
      if (!text) {
        // 空内容不入库：否则列表里会攒一堆空条目
        setError('还没有输入内容');
        return;
      }

      var now = Date.now();
      // 新的排在最上面 —— 速记是「刚想到的」优先，因此不需要排序选项
      persist([{ id: newId(), text: text, createdAt: now, updatedAt: now }].concat(itemsRef.current || []));

      // 清空输入框并同步清掉已存草稿，否则下次打开又冒出来
      setDraft('');
      flushDraft('');

      setError('');
      flash('已保存');
      if (inputRef.current) inputRef.current.focus();
    }

    function copy(text) {
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        setError('当前环境不支持剪贴板');
        return;
      }
      navigator.clipboard
        .writeText(text)
        .then(function () {
          flash('已复制');
        })
        .catch(function () {
          setError('复制失败，浏览器拒绝了剪贴板访问');
        });
    }

    function remove(id) {
      var target = (itemsRef.current || []).filter(function (i) {
        return i.id === id;
      })[0];
      if (!target) return;
      if (!window.confirm('删除这条速记？\n\n' + titleOf(target.text))) return;
      persist(
        (itemsRef.current || []).filter(function (i) {
          return i.id !== id;
        })
      );
    }

    function startEdit(item) {
      setEditing({ id: item.id, text: item.text });
      setError('');
    }

    function commitEdit() {
      if (!editing) return;
      var text = editing.text.trim();
      if (!text) {
        setError('内容不能为空');
        return;
      }
      persist(
        (itemsRef.current || []).map(function (i) {
          return i.id === editing.id
            ? { id: i.id, text: text, createdAt: i.createdAt, updatedAt: Date.now() }
            : i;
        })
      );
      setEditing(null);
      flash('已更新');
    }

    // ---- 快捷键 ----
    // **必须判断模块是否可见。** keydown 挂在 window 上，是窗口级的：
    // 不判断的话，用户在别的模块里按 Ctrl+Enter 也会保存这里的草稿。
    React.useEffect(
      function () {
        if (!active) return undefined;

        function onKey(event) {
          if (!(event.ctrlKey || event.metaKey)) return;
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (editing) commitEdit();
          else save();
        }

        window.addEventListener('keydown', onKey);
        return function () {
          window.removeEventListener('keydown', onKey);
        };
        // save / commitEdit 依赖当前 draft 与 items，因此需要跟着重建
        // eslint-disable-next-line react-hooks/exhaustive-deps
      },
      [active, draft, editing, items]
    );

    if (items === null) {
      return h('div', { className: 'nt-root' }, h('div', { className: 'nt-empty' }, '读取中…'));
    }

    // ---- 渲染 ----
    var composer = h(
      'div',
      { className: 'nt-composer' },
      h('textarea', {
        ref: inputRef,
        className: 'nt-input',
        placeholder: '要记点什么？写完点「保存」，或按 Ctrl+Enter。',
        value: draft,
        rows: 4,
        spellCheck: false,
        onChange: function (e) {
          updateDraft(e.target.value);
          if (error) setError('');
        },
      }),
      h(
        'div',
        { className: 'nt-composer-foot' },
        h(
          'span',
          { className: 'nt-hint' },
          draft.length > 0 ? draft.length + ' 字符' : '第一条换行之前的文字会当作标题'
        ),
        h('span', { className: 'nt-spacer' }),
        draft.length > 0
          ? h(
              'button',
              {
                className: 'nt-btn nt-btn-ghost',
                type: 'button',
                onClick: function () {
                  setDraft('');
                  flushDraft('');
                  if (inputRef.current) inputRef.current.focus();
                },
              },
              '清空'
            )
          : null,
        h('button', { className: 'nt-btn nt-btn-primary', type: 'button', onClick: save }, '保存')
      )
    );

    var errorNode = error
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

    var list;
    if (items.length === 0) {
      list = h('div', { className: 'nt-empty' }, '还没有速记。在上面写点什么，然后点「保存」。');
    } else {
      list = h(
        'div',
        { className: 'nt-list' },
        items.map(function (item) {
          var isEditing = editing && editing.id === item.id;

          if (isEditing) {
            return h(
              'div',
              { key: item.id, className: 'nt-item nt-item-editing' },
              h('textarea', {
                className: 'nt-input nt-input-edit',
                value: editing.text,
                rows: 5,
                spellCheck: false,
                autoFocus: true,
                onChange: function (e) {
                  setEditing({ id: editing.id, text: e.target.value });
                },
              }),
              h(
                'div',
                { className: 'nt-edit-actions' },
                h(
                  'button',
                  {
                    className: 'nt-btn nt-btn-ghost',
                    type: 'button',
                    onClick: function () {
                      setEditing(null);
                    },
                  },
                  '取消'
                ),
                h(
                  'button',
                  { className: 'nt-btn nt-btn-primary', type: 'button', onClick: commitEdit },
                  '确定'
                )
              )
            );
          }

          var rest = remainderOf(item.text);
          return h(
            'div',
            { key: item.id, className: 'nt-item' },
            h('div', { className: 'nt-item-title' }, titleOf(item.text)),
            rest ? h('div', { className: 'nt-item-rest' }, rest) : null,
            h(
              'div',
              { className: 'nt-item-foot' },
              h('span', { className: 'nt-item-time' }, formatTime(item.updatedAt)),
              h('span', { className: 'nt-spacer' }),
              // 卡片上平时不显示按钮，悬停时才浮出来 —— 列表因此保持干净，
              // 但操作又都在手边（不必先选中再找按钮）
              h(
                'div',
                { className: 'nt-item-actions' },
                h(
                  'button',
                  {
                    className: 'nt-btn nt-btn-mini',
                    type: 'button',
                    title: '复制全文',
                    onClick: function () {
                      copy(item.text);
                    },
                  },
                  '复制'
                ),
                h(
                  'button',
                  {
                    className: 'nt-btn nt-btn-mini',
                    type: 'button',
                    title: '修改',
                    onClick: function () {
                      startEdit(item);
                    },
                  },
                  '修改'
                ),
                h(
                  'button',
                  {
                    className: 'nt-btn nt-btn-mini nt-btn-danger',
                    type: 'button',
                    title: '删除',
                    onClick: function () {
                      remove(item.id);
                    },
                  },
                  '删除'
                )
              )
            )
          );
        })
      );
    }

    return h(
      'div',
      { className: 'nt-root' },
      h(
        'div',
        { className: 'nt-head' },
        h('h1', { className: 'nt-title' }, '文本速记'),
        h('span', { className: 'nt-subtitle' }, '想到什么就写下来，不必先想标题')
      ),
      composer,
      errorNode,
      h(
        'div',
        { className: 'nt-list-head' },
        h('span', { className: 'nt-list-title' }, '已记下'),
        h('span', { className: 'nt-count' }, String(items.length))
      ),
      list,
      h('div', { className: 'nt-footnote' }, '数据保存在插件自己的存储中，卸载插件会一并清除'),
      toast ? h('div', { className: 'nt-toast' }, toast) : null
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
