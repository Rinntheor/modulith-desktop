// samples/quick-launch/index.js
//
// 快捷启动 —— Modulith 示例插件（第二个示例）。
//
// 与 hello-plugin 的分工：那个演示「最小可用插件」的全部关键环节；这个演示
// **需要宿主提供原生能力的插件怎么写**，以及一个真实插件该有的完整形态。
//
// 用到的宿主能力（每一项都对应一条清单权限）：
//   * `ctx.storage`  —— 保存条目、分组与偏好          → storage
//   * `ctx.launcher` —— 启动程序                      → process-spawn
//   * `ctx.icons`    —— 提取程序图标                  → filesystem-read
//   * `ctx.shell`    —— 在文件管理器中定位            → filesystem-read
//   * `ctx.fileDrop` —— 接收拖入的文件路径            → filesystem-read
//
// 为什么这个文件是**手写的 IIFE** 而不是构建产物：示例的价值在于可读、可复制。
// 打包会让「源码」与「你看到的代码」之间隔一层配置。代价是不能用 JSX，
// 因此下面全部用 `React.createElement`（简写为 `h`）。
//
// 两条必须遵守的约定（与是否用构建工具无关）：
//   1. **不要自己 import React** —— 用 `Modulith.React`，宿主与插件必须共用
//      同一份实例，否则 hooks 会报错。
//   2. **必须在加载期同步调用 `registerModule()`**（IIFE 顶层，不能放进回调）。
//
// 本示例以 MIT 许可提供，欢迎直接复制作为你自己插件的起点。
// 复制时请替换名称、作者与图标。详见 ../../docs/07-法务/版权与授权.md。

(function () {
  'use strict';

  var Modulith = window.Modulith;
  if (!Modulith) {
    console.error('[quick-launch] 未找到 window.Modulith，插件无法加载');
    return;
  }

  var React = Modulith.React;
  var h = React.createElement;

  // createContext() 只能在加载期调用，因此在这里取一次并长期持有。
  var ctx = Modulith.createContext();

  /** 条目与分组存在这个键下；图标另存，见 ICON_PREFIX */
  var STATE_KEY = 'shortcuts';
  /**
   * 每个条目的图标单独存一个键。
   *
   * 为什么不塞进 STATE_KEY 里：图标是几十 KB 的 PNG data URL，全部塞进一个
   * 数组会让「改个名字」也重写整份数据。分开存之后主状态始终很小。
   *
   * 注意键名字符集限制：后端只允许字母数字与 `.` `_` `-`（最长 128），
   * 因此这里用 `icon.<id>` 而不是 `icon:<id>` —— 冒号会被拒绝。
   */
  var ICON_PREFIX = 'icon.';

  var VIEWS = [
    { id: 'grid', label: '网格' },
    { id: 'list', label: '列表' },
    { id: 'compact', label: '紧凑' },
  ];

  // ============================================================
  // 小工具
  // ============================================================

  function newId(prefix) {
    return prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /** 取路径最后一段（同时兼容 `/` 与 `\`） */
  function basename(path) {
    var parts = String(path).split(/[\\/]/);
    return parts[parts.length - 1] || String(path);
  }

  function stripExtension(name) {
    var i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  }

  /** 拖进来的可能是文件也可能是目录，用扩展名做个粗判 */
  function looksLikeFile(path) {
    var base = basename(path);
    var i = base.lastIndexOf('.');
    return i > 0 && i < base.length - 1;
  }

  function emptyState() {
    return {
      version: 1,
      items: [],
      groups: [],
      view: 'grid',
      filter: 'all',
    };
  }

  /**
   * 把存储里读到的任何东西整理成当前结构。
   *
   * 这里刻意兼容最早那个版本 —— 它直接把条目数组存在 `shortcuts` 下。
   * 存储格式会随插件演进，读的时候容错比写的时候谨慎更重要：用户的数据只有
   * 一份，读失败就全丢了。
   */
  function normalizeState(raw) {
    if (!raw) return emptyState();

    if (Array.isArray(raw)) {
      return {
        version: 1,
        items: raw.map(function (item) {
          return {
            id: item.id || newId('sc-'),
            name: item.name || basename(item.target || ''),
            target: item.target || '',
            args: Array.isArray(item.args) ? item.args : [],
            groupId: null,
            note: '',
            addedAt: item.addedAt || Date.now(),
          };
        }),
        groups: [],
        view: 'grid',
        filter: 'all',
      };
    }

    var state = emptyState();
    state.items = (Array.isArray(raw.items) ? raw.items : []).map(function (item) {
      return {
        id: item.id || newId('sc-'),
        name: item.name || basename(item.target || ''),
        target: item.target || '',
        args: Array.isArray(item.args) ? item.args : [],
        groupId: item.groupId || null,
        note: typeof item.note === 'string' ? item.note : '',
        addedAt: item.addedAt || Date.now(),
      };
    });
    state.groups = (Array.isArray(raw.groups) ? raw.groups : []).map(function (g) {
      return { id: g.id || newId('g-'), name: g.name || '未命名分组' };
    });
    state.view = VIEWS.some(function (v) {
      return v.id === raw.view;
    })
      ? raw.view
      : 'grid';
    state.filter = raw.filter || 'all';

    // 指向已删除分组的条目回落到「未分组」，否则它们会从任何筛选下消失
    var known = {};
    state.groups.forEach(function (g) {
      known[g.id] = true;
    });
    state.items.forEach(function (item) {
      if (item.groupId && !known[item.groupId]) item.groupId = null;
    });

    return state;
  }

  /** 解析「参数」输入框：按空白切分，不支持引号（见 README） */
  function parseArgs(text) {
    return String(text || '')
      .split(/\s+/)
      .filter(function (s) {
        return s.length > 0;
      });
  }

  // ============================================================
  // 图标
  // ============================================================

  /** 已解析的图标：id -> dataURL（空串表示提取失败，避免反复重试） */
  var iconCache = {};
  /** 正在解析中的 id，防止重复发起 */
  var iconPending = {};

  /** 先看存储里有没有，没有再请宿主提取一次并写回存储 */
  function resolveIcon(item) {
    return ctx.storage
      .get(ICON_PREFIX + item.id, null)
      .then(function (saved) {
        if (saved) return saved;
        return ctx.icons.extract(item.target).then(function (url) {
          // 写回存储，下次启动就不必再调宿主
          return ctx.storage.set(ICON_PREFIX + item.id, url).then(function () {
            return url;
          });
        });
      })
      .catch(function (e) {
        // 提取失败不是致命错误（文件可能已被删除、也可能是没有图标资源的文件），
        // 记一条日志并回退到通用图标。
        ctx.logger.warn('提取图标失败：' + item.target, e);
        return '';
      });
  }

  /** 丢弃某个条目缓存的图标，下次渲染时重新提取 */
  function invalidateIcon(id) {
    delete iconCache[id];
    delete iconPending[id];
    return ctx.storage.delete(ICON_PREFIX + id).catch(function () {});
  }

  // ============================================================
  // 右键菜单
  // ============================================================

  /**
   * 一个最小的右键菜单。
   *
   * 插件**不能复用宿主的组件**（`Sidebar/ModuleContextMenu` 之类），因为插件是
   * 独立 bundle、只能拿到 `Modulith.React`。因此这里自己实现一份。
   *
   * 位置会按视口做钳制：贴着右下角右键时，菜单不该跑到屏幕外。
   */
  function ContextMenu(props) {
    var ref = React.useRef(null);
    var coords = React.useState({ x: props.x, y: props.y });
    var pos = coords[0];
    var setPos = coords[1];

    React.useEffect(
      function () {
        var node = ref.current;
        if (!node) return;
        var rect = node.getBoundingClientRect();
        var x = props.x;
        var y = props.y;
        var margin = 8;
        if (x + rect.width + margin > window.innerWidth) x = window.innerWidth - rect.width - margin;
        if (y + rect.height + margin > window.innerHeight) y = window.innerHeight - rect.height - margin;
        setPos({ x: Math.max(margin, x), y: Math.max(margin, y) });
      },
      [props.x, props.y]
    );

    React.useEffect(
      function () {
        function onDown(event) {
          if (ref.current && ref.current.contains(event.target)) return;
          props.onClose();
        }
        function onKey(event) {
          if (event.key === 'Escape') props.onClose();
        }
        // 捕获阶段监听，保证在任何其它处理之前关闭
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', props.onClose);
        return function () {
          document.removeEventListener('mousedown', onDown, true);
          document.removeEventListener('keydown', onKey);
          window.removeEventListener('resize', props.onClose);
        };
      },
      [props]
    );

    return h(
      'div',
      {
        ref: ref,
        className: 'ql-menu',
        style: { left: pos.x + 'px', top: pos.y + 'px' },
        onContextMenu: function (event) {
          event.preventDefault();
        },
      },
      props.items.map(function (item, index) {
        if (item.separator) {
          return h('div', { key: 'sep-' + index, className: 'ql-menu-sep' });
        }
        if (item.heading) {
          return h('div', { key: 'head-' + index, className: 'ql-menu-heading' }, item.label);
        }
        return h(
          'button',
          {
            key: item.label + '-' + index,
            type: 'button',
            className: 'ql-menu-item' + (item.danger ? ' ql-menu-item-danger' : '') + (item.checked ? ' ql-menu-item-checked' : ''),
            onClick: function () {
              props.onClose();
              item.onClick();
            },
          },
          h('span', { className: 'ql-menu-label' }, item.label),
          item.checked ? h('span', { className: 'ql-menu-mark' }, '✓') : null
        );
      })
    );
  }

  // ============================================================
  // 编辑 / 新增对话框
  // ============================================================

  function EditDialog(props) {
    var draftState = React.useState(props.draft);
    var draft = draftState[0];
    var setDraft = draftState[1];

    function patch(part) {
      setDraft(Object.assign({}, draft, part));
    }

    function submit() {
      if (!String(draft.target || '').trim()) {
        patch({ error: '请填写程序路径' });
        return;
      }
      props.onSubmit(draft);
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') props.onCancel();
      // Ctrl/Cmd + Enter 提交，普通 Enter 留给多行备注
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit();
    }

    function field(label, hint, control) {
      return h(
        'label',
        { className: 'ql-field' },
        h('span', { className: 'ql-field-label' }, label),
        control,
        hint ? h('span', { className: 'ql-field-hint' }, hint) : null
      );
    }

    return h(
      'div',
      {
        className: 'ql-overlay',
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) props.onCancel();
        },
      },
      h(
        'div',
        { className: 'ql-dialog', onKeyDown: onKeyDown },
        h('h2', { className: 'ql-dialog-title' }, props.mode === 'new' ? '添加快捷方式' : '编辑快捷方式'),

        props.error || draft.error
          ? h('div', { className: 'ql-error' }, h('span', { className: 'ql-error-text' }, props.error || draft.error))
          : null,

        field(
          '名称',
          '留空时取程序文件名',
          h('input', {
            className: 'ql-input',
            type: 'text',
            value: draft.name,
            autoFocus: true,
            onChange: function (e) {
              patch({ name: e.target.value, error: '' });
            },
          })
        ),

        field(
          '程序路径',
          '必须是绝对路径，例如 C:\\Program Files\\App\\app.exe',
          h('input', {
            className: 'ql-input ql-input-mono',
            type: 'text',
            value: draft.target,
            onChange: function (e) {
              patch({ target: e.target.value, error: '' });
            },
          })
        ),

        field(
          '启动参数',
          '按空格分隔，不支持引号',
          h('input', {
            className: 'ql-input ql-input-mono',
            type: 'text',
            value: draft.argsText,
            placeholder: '可选',
            onChange: function (e) {
              patch({ argsText: e.target.value });
            },
          })
        ),

        field(
          '分组',
          null,
          h(
            'select',
            {
              className: 'ql-input',
              value: draft.groupId || '',
              onChange: function (e) {
                patch({ groupId: e.target.value || null });
              },
            },
            h('option', { value: '' }, '未分组'),
            props.groups.map(function (g) {
              return h('option', { key: g.id, value: g.id }, g.name);
            })
          )
        ),

        field(
          '备注',
          '鼠标悬浮在卡片上时显示',
          h('textarea', {
            className: 'ql-input ql-textarea',
            rows: 3,
            value: draft.note,
            placeholder: '可选',
            onChange: function (e) {
              patch({ note: e.target.value });
            },
          })
        ),

        h(
          'div',
          { className: 'ql-dialog-actions' },
          h(
            'button',
            {
              className: 'ql-btn ql-btn-ghost',
              type: 'button',
              onClick: function () {
                props.onRefreshIcon();
              },
            },
            '重新提取图标'
          ),
          h('span', { className: 'ql-dialog-spacer' }),
          h('button', { className: 'ql-btn ql-btn-ghost', type: 'button', onClick: props.onCancel }, '取消'),
          h('button', { className: 'ql-btn ql-btn-primary', type: 'button', onClick: submit }, '保存')
        )
      )
    );
  }

  // ============================================================
  // 主界面
  // ============================================================

  function QuickLaunch() {
    var statePair = React.useState(null);
    var state = statePair[0];
    var setState = statePair[1];

    var iconsPair = React.useState({});
    var icons = iconsPair[0];
    var setIcons = iconsPair[1];

    var errorPair = React.useState('');
    var error = errorPair[0];
    var setError = errorPair[1];

    var menuPair = React.useState(null);
    var menu = menuPair[0];
    var setMenu = menuPair[1];

    var dialogPair = React.useState(null);
    var dialog = dialogPair[0];
    var setDialog = dialogPair[1];

    var droppingPair = React.useState(false);
    var dropping = droppingPair[0];
    var setDropping = droppingPair[1];

    var tooltipPair = React.useState(null);
    var tooltip = tooltipPair[0];
    var setTooltip = tooltipPair[1];

    // 最新状态放进 ref，供拖放订阅者读取 —— 否则每次状态变化都要重建订阅
    var stateRef = React.useRef(null);
    React.useEffect(
      function () {
        stateRef.current = state;
      },
      [state]
    );

    // ---- 载入 ----
    React.useEffect(function () {
      var alive = true;
      ctx.storage
        .get(STATE_KEY, null)
        .then(function (raw) {
          if (!alive) return;
          setState(normalizeState(raw));
        })
        .catch(function (e) {
          if (!alive) return;
          setError('读取已保存的内容失败：' + e);
          setState(emptyState());
        });
      return function () {
        alive = false;
      };
    }, []);

    function persist(next) {
      setState(next);
      ctx.storage.set(STATE_KEY, next).catch(function (e) {
        setError('保存失败：' + e);
      });
    }

    // ---- 图标懒加载 ----
    React.useEffect(
      function () {
        if (!state) return;
        state.items.forEach(function (item) {
          if (icons[item.id] !== undefined || iconPending[item.id]) return;
          if (iconCache[item.id] !== undefined) {
            var cached = iconCache[item.id];
            setIcons(function (prev) {
              var next = Object.assign({}, prev);
              next[item.id] = cached;
              return next;
            });
            return;
          }
          iconPending[item.id] = true;
          resolveIcon(item).then(function (url) {
            iconPending[item.id] = false;
            iconCache[item.id] = url;
            setIcons(function (prev) {
              var next = Object.assign({}, prev);
              next[item.id] = url;
              return next;
            });
          });
        });
      },
      [state, icons]
    );

    // ---- 拖放添加 ----
    // 只有在模块真正可见时才订阅：拖放事件是**窗口级**的，
    // 若在后台也保持订阅，就会抢走本该属于其它模块的拖入。
    var active = Modulith.useModuleActive();
    React.useEffect(
      function () {
        if (!active) return undefined;
        return ctx.fileDrop.subscribe(function (event) {
          if (event.type === 'enter' || event.type === 'over') {
            setDropping(true);
            return;
          }
          if (event.type === 'leave') {
            setDropping(false);
            return;
          }
          if (event.type !== 'drop') return;
          setDropping(false);

          var current = stateRef.current;
          if (!current) return;

          var files = (event.paths || []).filter(looksLikeFile);
          if (files.length === 0) {
            setError('拖入的内容里没有可添加的文件（目录暂不支持）');
            return;
          }

          // 拖到某个分组下时，新条目直接落进该分组
          var groupId = filter !== 'all' && filter !== 'none' ? filter : null;

          var added = files.map(function (path) {
            return {
              id: newId('sc-'),
              name: stripExtension(basename(path)),
              target: path,
              args: [],
              groupId: groupId,
              note: '',
              addedAt: Date.now(),
            };
          });

          // 一次写入。切到能看到新条目的筛选，否则用户会以为拖入没生效。
          persist(
            Object.assign({}, current, {
              items: current.items.concat(added),
              filter: groupId || 'all',
            })
          );
          setError('');
        });
      },
      [active]
    );

    // ---- 派生数据 ----
    var items = state ? state.items : [];
    var groups = state ? state.groups : [];
    var view = state ? state.view : 'grid';
    var filter = state ? state.filter : 'all';

    var visible = items.filter(function (item) {
      if (filter === 'all') return true;
      if (filter === 'none') return !item.groupId;
      return item.groupId === filter;
    });

    function countFor(id) {
      if (id === 'all') return items.length;
      if (id === 'none')
        return items.filter(function (i) {
          return !i.groupId;
        }).length;
      return items.filter(function (i) {
        return i.groupId === id;
      }).length;
    }

    // ---- 操作 ----
    function patchState(part) {
      persist(Object.assign({}, state, part));
    }

    function launch(item) {
      setError('');
      ctx.launcher.launch(item.target, item.args || []).catch(function (e) {
        setError('启动失败：' + e);
      });
    }

    function reveal(item) {
      setError('');
      ctx.shell.revealInFolder(item.target).catch(function (e) {
        setError('无法打开所在文件夹：' + e);
      });
    }

    function remove(item) {
      invalidateIcon(item.id);
      patchState({
        items: items.filter(function (i) {
          return i.id !== item.id;
        }),
      });
    }

    function copyPath(item) {
      // 用浏览器的剪贴板 API，而不是宿主的剪贴板权限：这里不需要读剪贴板，
      // 只写一段用户自己填过的路径，风险与复杂度都更低。
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(item.target).catch(function () {
          setError('复制失败，浏览器拒绝了剪贴板访问');
        });
      } else {
        setError('当前环境不支持剪贴板');
      }
    }

    function openNewDialog() {
      setDialog({
        mode: 'new',
        draft: {
          id: newId('sc-'),
          name: '',
          target: '',
          argsText: '',
          groupId: filter !== 'all' && filter !== 'none' ? filter : null,
          note: '',
          error: '',
        },
      });
    }

    function openEditDialog(item) {
      setDialog({
        mode: 'edit',
        itemId: item.id,
        draft: {
          id: item.id,
          name: item.name,
          target: item.target,
          argsText: (item.args || []).join(' '),
          groupId: item.groupId,
          note: item.note || '',
          error: '',
        },
      });
    }

    function submitDialog(draft) {
      var name = String(draft.name || '').trim() || stripExtension(basename(draft.target));
      var patch = {
        name: name,
        target: String(draft.target).trim(),
        args: parseArgs(draft.argsText),
        groupId: draft.groupId || null,
        note: String(draft.note || '').trim(),
      };

      if (dialog.mode === 'new') {
        patchState({
          items: items.concat([Object.assign({ id: draft.id, addedAt: Date.now() }, patch)]),
        });
      } else {
        // 路径可能变了，图标缓存必须作废
        var previous = items.filter(function (i) {
          return i.id === dialog.itemId;
        })[0];
        if (previous && previous.target !== patch.target) {
          invalidateIcon(dialog.itemId).then(function () {
            setIcons(function (prev) {
              var next = Object.assign({}, prev);
              delete next[dialog.itemId];
              return next;
            });
          });
        }
        patchState({
          items: items.map(function (i) {
            return i.id === dialog.itemId ? Object.assign({}, i, patch) : i;
          }),
        });
      }
      setDialog(null);
    }

    function createGroup() {
      var name = window.prompt('新分组名称', '');
      if (name === null) return;
      name = name.trim();
      if (!name) return;
      patchState({ groups: groups.concat([{ id: newId('g-'), name: name }]) });
    }

    function renameGroup(group) {
      var name = window.prompt('重命名分组', group.name);
      if (name === null) return;
      name = name.trim();
      if (!name) return;
      patchState({
        groups: groups.map(function (g) {
          return g.id === group.id ? { id: g.id, name: name } : g;
        }),
      });
    }

    function deleteGroup(group) {
      var count = countFor(group.id);
      if (
        count > 0 &&
        !window.confirm('「' + group.name + '」里还有 ' + count + ' 个条目，删除分组后它们会移到「未分组」。继续？')
      ) {
        return;
      }
      patchState({
        groups: groups.filter(function (g) {
          return g.id !== group.id;
        }),
        items: items.map(function (i) {
          return i.groupId === group.id ? Object.assign({}, i, { groupId: null }) : i;
        }),
        filter: filter === group.id ? 'all' : filter,
      });
    }

    // ---- 菜单 ----
    function itemMenu(event, item) {
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY, item: item });
    }

    function backgroundMenu(event) {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY, item: null });
    }

    function groupMenu(event, group) {
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY, group: group });
    }

    var menuNode = null;
    if (menu) {
      var entries;
      if (menu.group) {
        entries = [
          { heading: true, label: menu.group.name },
          { label: '重命名分组', onClick: function () { renameGroup(menu.group); } },
          { label: '删除分组', danger: true, onClick: function () { deleteGroup(menu.group); } },
        ];
      } else if (menu.item) {
        entries = [
          { label: '打开', onClick: function () { launch(menu.item); } },
          { label: '打开所在文件夹', onClick: function () { reveal(menu.item); } },
          { label: '编辑…', onClick: function () { openEditDialog(menu.item); } },
          { label: '复制路径', onClick: function () { copyPath(menu.item); } },
          { separator: true },
        ];
        entries.push({ heading: true, label: '移入分组' });
        entries.push({
          label: '未分组',
          checked: !menu.item.groupId,
          onClick: function () {
            moveToGroup(menu.item, null);
          },
        });
        groups.forEach(function (g) {
          entries.push({
            label: g.name,
            checked: menu.item.groupId === g.id,
            onClick: function () {
              moveToGroup(menu.item, g.id);
            },
          });
        });
        if (groups.length === 0) {
          entries.push({ label: '（还没有分组）', onClick: function () {} });
        }
        entries.push({ separator: true });
        entries.push({ label: '删除', danger: true, onClick: function () { remove(menu.item); } });
      } else {
        entries = [
          { label: '添加快捷方式…', onClick: openNewDialog },
          { label: '新建分组…', onClick: createGroup },
          { separator: true },
          { heading: true, label: '视图' },
        ];
        VIEWS.forEach(function (v) {
          entries.push({
            label: v.label,
            checked: view === v.id,
            onClick: function () {
              patchState({ view: v.id });
            },
          });
        });
      }
      menuNode = h(ContextMenu, {
        x: menu.x,
        y: menu.y,
        items: entries,
        onClose: function () {
          setMenu(null);
        },
      });
    }

    function moveToGroup(item, groupId) {
      patchState({
        items: items.map(function (i) {
          return i.id === item.id ? Object.assign({}, i, { groupId: groupId }) : i;
        }),
      });
    }

    // ---- 渲染 ----
    if (!state) {
      return h('div', { className: 'ql-root' }, h('div', { className: 'ql-empty' }, '读取中…'));
    }

    var toolbar = h(
      'div',
      { className: 'ql-toolbar' },
      h('h1', { className: 'ql-title' }, '快捷启动'),
      h(
        'div',
        { className: 'ql-segmented', role: 'group', 'aria-label': '视图' },
        VIEWS.map(function (v) {
          return h(
            'button',
            {
              key: v.id,
              type: 'button',
              className: 'ql-seg' + (view === v.id ? ' ql-seg-active' : ''),
              onClick: function () {
                patchState({ view: v.id });
              },
            },
            v.label
          );
        })
      ),
      h(
        'button',
        { className: 'ql-btn ql-btn-primary', type: 'button', onClick: openNewDialog },
        '添加'
      )
    );

    var chips = [{ id: 'all', name: '全部' }, { id: 'none', name: '未分组' }].concat(groups);

    var groupBar = h(
      'div',
      { className: 'ql-groups' },
      chips.map(function (chip) {
        var isGroup = chip.id !== 'all' && chip.id !== 'none';
        var group = isGroup
          ? groups.filter(function (g) {
              return g.id === chip.id;
            })[0]
          : null;
        return h(
          'button',
          {
            key: chip.id,
            type: 'button',
            className: 'ql-chip' + (filter === chip.id ? ' ql-chip-active' : ''),
            onClick: function () {
              patchState({ filter: chip.id });
            },
            onContextMenu: group
              ? function (event) {
                  groupMenu(event, group);
                }
              : undefined,
          },
          h('span', null, chip.name),
          h('span', { className: 'ql-chip-count' }, String(countFor(chip.id)))
        );
      }),
      h('button', { className: 'ql-chip ql-chip-add', type: 'button', onClick: createGroup }, '+ 分组')
    );

    var banner = error
      ? h(
          'div',
          { className: 'ql-error', role: 'alert' },
          h('span', { className: 'ql-error-text' }, error),
          h(
            'button',
            {
              className: 'ql-error-close',
              type: 'button',
              onClick: function () {
                setError('');
              },
              title: '关闭',
            },
            '×'
          )
        )
      : null;

    var body;
    if (visible.length === 0) {
      body = h(
        'div',
        { className: 'ql-empty' },
        items.length === 0
          ? '还没有条目。点右上角「添加」，或把程序文件直接拖进这个窗口。'
          : '这个分组下还没有条目。'
      );
    } else {
      body = h(
        'div',
        { className: 'ql-grid ql-view-' + view },
        visible.map(function (item) {
          var icon = icons[item.id];
          return h(
            'div',
            {
              key: item.id,
              className: 'ql-card',
              onDoubleClick: function () {
                launch(item);
              },
              onContextMenu: function (event) {
                itemMenu(event, item);
              },
              onMouseEnter: function (event) {
                if (!item.note) return;
                var rect = event.currentTarget.getBoundingClientRect();
                setTooltip({ text: item.note, x: rect.left + rect.width / 2, y: rect.top });
              },
              onMouseLeave: function () {
                setTooltip(null);
              },
            },
            h(
              'div',
              { className: 'ql-card-icon' },
              icon
                ? h('img', { src: icon, alt: '', draggable: false })
                : h('div', { className: 'ql-card-icon-fallback' }, stripExtension(basename(item.target)).slice(0, 2).toUpperCase())
            ),
            h(
              'div',
              { className: 'ql-card-text' },
              h('span', { className: 'ql-card-name', title: item.name }, item.name),
              h('span', { className: 'ql-card-path', title: item.target }, item.target)
            ),
            item.note ? h('span', { className: 'ql-card-note-dot', title: '有备注' }) : null
          );
        })
      );
    }

    var dialogNode = dialog
      ? h(EditDialog, {
          mode: dialog.mode,
          draft: dialog.draft,
          groups: groups,
          error: error,
          onCancel: function () {
            setDialog(null);
          },
          onSubmit: submitDialog,
          onRefreshIcon: function () {
            var id = dialog.draft.id;
            invalidateIcon(id).then(function () {
              setIcons(function (prev) {
                var next = Object.assign({}, prev);
                delete next[id];
                return next;
              });
            });
          },
        })
      : null;

    var tooltipNode =
      tooltip && tooltip.text
        ? h(
            'div',
            {
              className: 'ql-tooltip',
              style: { left: tooltip.x + 'px', top: tooltip.y + 'px' },
            },
            tooltip.text
          )
        : null;

    return h(
      'div',
      {
        className: 'ql-root' + (dropping ? ' ql-dropping' : ''),
        onContextMenu: backgroundMenu,
      },
      toolbar,
      groupBar,
      banner,
      body,
      dropping ? h('div', { className: 'ql-dropHint' }, '松开即可添加为快捷方式') : null,
      menuNode,
      dialogNode,
      tooltipNode
    );
  }

  Modulith.registerModule({
    id: 'quick-launch',
    name: '快捷启动',
    description: '把常用程序收在一处，点一下就打开',
    icon: 'Rocket',
    priority: 80,
    component: QuickLaunch,
  });
})();
