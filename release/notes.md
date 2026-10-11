# Modulith Desktop 1.8.0

这一版补齐了「打开东西」与「显示图标」这两件小事上的短板 —— 它们看着琐碎，却是你一眼就能看见的那种：桌面上的快捷方式打不开、插件顶着的不是自己的图标、右键菜单的图标永远是空的。另外修掉了一个会**反复冤枉插件**的安全模式误报。

This release fills in the gaps around two small things — opening files and showing icons — small only until you look at the screen: shortcuts on your desktop would not open, plugins wore the host's icon instead of their own, and context-menu entries were always blank. It also fixes a safe-mode false alarm that could repeat and blame your plugins for nothing.

- [中文](#中文)
- [English](#english)

---

## 中文

### 现在能打开快捷方式、网址、文档和目录了

在此之前，「打开一个东西」只有一条路，而它只认**可执行程序**。把桌面上的快捷方式交给它，得到的是一句「%1 不是有效的 Win32 应用程序」；网址也一样打不开 —— 因为快捷方式和网址都不是程序，它们是**交给 Windows 去解释的一份数据**。

现在有了 `ctx.launcher.open(target)`：快捷方式、网址、文档、目录都能打开，而且用的是**你自己为这种文件选定的那个程序** —— `.txt` 用你设的编辑器，`.html` 用你的浏览器，文件夹用资源管理器。快捷启动一类的插件因此终于能打开桌面上那个图标。

两点刻意收着的地方：它**没有**申请一项新权限（仍在「启动程序」那一项之下 —— 它没有多出什么能力，单开一项只会逼着「只想打开网址」的插件去申请最吓人的那一档）；网址也只放行 `http` / `https` / `mailto` 三种，其它一律按本机文件路径处理。

### 插件图标现在是插件自己那张图了

这一版修掉了三个相关的毛病，都是「看得见、但说不清为什么」的那种：

- **插件模块的图标用错了图，或者干脆是空白。** 启动后第一眼看到的侧边栏里，模块要么顶着宿主机自带图标库里的一个图标，要么是一个空白方块 —— 而插件其实自带了图标。根因是补图标发生得太晚（要等后台那一趟），而**安全模式下永远不补**。现在两条启动路径都会补图，模块自己声明的图标文件也会被正确读取。
- **右键菜单里的图标一直是空白。** 同一类原因的另一个落点：那一处根本没把插件自己的图传给渲染。
- **一个写错的图标名会让整条侧边栏条目崩掉。** 插件清单里写了一个不存在的图标名时，整条条目会直接消失（界面报错），而不是显示一个兜底图标。现在落回兜底图标。

顺带一提：以后侧边栏、仪表盘和右键菜单对同一个插件显示的是同一张图。

### 图标也能从快捷方式、文档、目录上取到了 —— 这是一条契约变更

`ctx.icons.extract` 此前只认「可执行文件里嵌着的图标」。对它使用快捷方式、`.url`、批处理脚本或文档，**必然**拿不到图标 —— 而且失败得毫无声息（返回 0，不报错），于是插件作者很容易以为自己写错了。

现在它会退一步去问 Windows 的资源管理器：这个文件用哪个图标？你在资源管理器里看到的那个图标，就是它返回的。

有一件事必须如实说明：**这改掉了一条旧契约**。此前「非可执行文件取不到图标」是**保证会失败**的，现在不再成立 —— **调用方不该再靠"它失败了"来判断「这个文件没有图标」**，因为那种文件在 Windows 上基本不存在。原先那条契约把实现细节（有没有嵌着的图标资源）当成了产品语义，而新约定更强也更简单：要么给你一张真正的图，要么明确报错；**不会**拿空图或占位图糊弄过去。

### 安全模式不再冤枉插件

安全模式的原意是：上一次启动**被插件弄到起不来**时，下一次先不带插件启动，让你进得去、也能把它关掉。

但那个「上一次没走干净」的标记**每次启动都写、只有走完正常退出才删**。于是**任何**非正常结束 —— 任务管理器结束进程、程序崩溃、直接关机、开发时反复强杀、运行中被重新构建覆盖 —— 都会让**下一次启动进入安全模式，并把原因归咎于插件**，而用户什么都没做错。更麻烦的是安全模式「不做处理就会一直进」，所以一次误报会连续出现好几次。

现在用一对标记把两种情况分开：

- **上一次死在启动阶段** —— 插件嫌疑最大，**仍然进安全模式**，保护强度不变。
- **上一次跑起来过，只是没正常退出** —— 不进安全模式。你按了任务管理器，就是这个样子。

另外，判断「这一次启动真的成功了」用的不是延时、也不是「窗口已经显示」，而是**界面真正走到插件那一步**。理由是：插件把界面卡死时，进程的事件循环还是活着的 —— 用前面那两种判据，恰好会在**唯一真正该进安全模式的那个场景**失效。

### 升级与兼容

- **插件清单的 `engines.modulith` 下界不需要变。** 新增的 `ctx.launcher.open` 是**可选**能力，插件应当先做能力探测（有这个函数才调用），而不是把宿主版本要求一路抬高。
- **已发布插件的旧版本在本版上行为不变**，没有插件需要改动。
- 权限表**没有变化**：`ctx.launcher.open` 复用的仍是「启动程序」那一项，`ctx.icons.extract` 本来就在。

### 说明

- `ctx.icons.extract` 有了一条新契约，这一点在上面单独说明了。如果你的插件里有「取不到图标就当作这个文件没有图标」这样的分支，那一段现在不会再走到 —— 不是出了错，而是它不再是一条有意义的判断。
- 另有一处**不变式**改动：交给系统取图标的路径现在会先剥掉 `\\?\` 前缀。实测在这台机器上剥与不剥拿到的是**同一张图**（像素逐字节相同），因此它不是某个可复现故障的修复 —— 这么做只是因为 Windows 对那个前缀**没有契约**，而代价为零。

## English

### Shortcuts, links, documents and folders now open

Until now there was one way to "open something", and it only accepted **executables**. Hand it a shortcut from your desktop and you got "%1 is not a valid Win32 application"; a web link failed the same way — because a shortcut and a link are not programs, they are **data for Windows to interpret**.

There is now `ctx.launcher.open(target)`: shortcuts, web links, documents and folders all open, each with **the program you yourself chose for that kind of file** — your editor for `.txt`, your browser for `.html`, Explorer for a folder. A quick-launch plugin can finally open that icon on your desktop.

Two deliberate restraints: it **does not** ask for a new permission (it stays under "spawn a process" — it grants no capability that was not already there, and a separate entry would only force a plugin that merely wants to open a link to request the most alarming one); and links are limited to `http` / `https` / `mailto`, with anything else treated as a local file path.

### Plugin icons are the plugin's own icon now

Three related problems are fixed here, all of the "you can see it but cannot explain it" kind:

- **Plugin module icons used the wrong image, or none at all.** In the sidebar you see right after launch, a module either wore one of the host's built-in icons or was a blank square — even though the plugin ships its own icon. The cause was that icons were filled in too late (only on the background pass), and in **safe mode they never were**. Both startup paths now fill them in, and an icon file the module declares itself is read correctly.
- **Context-menu entry icons were always blank.** Another landing point of the same cause: that path never handed the plugin's own image to the renderer.
- **One mistyped icon name could take down a whole sidebar entry.** With a non-existent icon name in the manifest the entry vanished outright (the UI raised an error) instead of falling back. It now falls back to the built-in icon.

As a side effect, the sidebar, the dashboard and the context menu now show the same image for the same plugin.

### Icons can now be extracted from shortcuts, documents and folders — this is a contract change

`ctx.icons.extract` used to accept only "an icon embedded in an executable". Pointed at a shortcut, a `.url`, a batch script or a document it **always** failed — and it failed silently (returning 0, raising nothing), so plugin authors easily concluded they had made a mistake.

It now falls back to asking Windows' shell: which icon does this file use? The icon you see in Explorer is the one it returns.

One thing must be said plainly: **this changes an old contract**. "A non-executable file yields no icon" used to be a **guaranteed failure**, and it no longer is — **callers should not use "it failed" to decide that a file has no icon**, because on Windows such a file essentially does not exist. The old contract mistook an implementation detail (whether an icon resource is embedded) for product semantics. The new promise is stronger and simpler: either you get a real image, or you get a clear error; you will **not** get a blank or placeholder image pretending to be one.

### Safe mode no longer blames your plugins

Safe mode exists so that when a plugin **made the app unable to start** last time, the next launch starts without plugins, letting you get in and turn that plugin off.

But the "last run did not finish cleanly" marker was **written on every launch and deleted only on a clean exit**. So **any** abnormal end — ending the process from Task Manager, a crash, shutting down the machine, killing it repeatedly during development, or a rebuild overwriting it while running — made the **next launch enter safe mode and blame the plugins**, when the user had done nothing wrong. Worse, safe mode "keeps entering until you do something about it", so one false alarm appeared several times in a row.

A pair of markers now separates the two cases:

- **Last time it died during startup** — plugins are the prime suspect, so it **still enters safe mode**. The protection is unchanged.
- **Last time it ran and simply did not exit cleanly** — it does not enter safe mode. That is what "you used Task Manager" looks like.

Also, "this launch actually succeeded" is no longer decided by a delay or by "the window is showing", but by **the UI genuinely reaching the plugin step**. The reason: when a plugin freezes the UI, the process event loop is still alive — both of the other criteria would still hold, and would fail exactly in **the one case that really should enter safe mode**.

### Upgrading and compatibility

- **The `engines.modulith` lower bound in plugin manifests does not need to change.** The new `ctx.launcher.open` is **optional**; plugins should probe for it (call it only if it exists) rather than raising the host requirement.
- **Existing plugins behave exactly as before on this version**; none of them need changes.
- The permission table is **unchanged**: `ctx.launcher.open` still uses the existing "spawn a process" entry, and `ctx.icons.extract` was already there.

### Notes

- `ctx.icons.extract` has a new contract, described separately above. If your plugin has a branch that treats "extraction failed" as "this file has no icon", that branch will no longer be reached — not because something broke, but because it is no longer a meaningful test.
- One further **invariant** change: paths handed to the system for icon extraction now have the `\\?\` prefix stripped first. Measured on this machine, stripping and not stripping return **the same image** (byte-for-byte identical pixels), so this is not the fix for any reproducible defect — it is done only because Windows makes **no promise** about that prefix and the cost is zero.
